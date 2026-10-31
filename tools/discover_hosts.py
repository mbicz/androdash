#!/usr/bin/env python3
"""Discover the exporters an AndroDash phone can scrape, and write its Ignition.

The phone is the appliance; its configuration is a list of dashboards and a list
of scrape targets (C-001). Both are derived from what is actually reachable, so
nothing is invented: an exporter is listed only when it answers on its port and
its `/metrics` text proves which dashboard can read it.

Sources of candidate hosts, all optional:

    --host       an address or hostname to probe (repeatable)
    --prometheus a Prometheus base URL; its active targets are probed too
    LAN          the ARP table (`arp -an`), i.e. hosts this machine talked to
    tailnet      `tailscale status`, when Tailscale is installed

Exporter ports (the documented integration ports):

    9100 node_exporter      -> job `node`,        macos-node dashboard
    9106 agenticmac-exporter -> job `agenticmac`, agenticmac dashboard
    9091 demo/mock Prometheus -> job `demo`,       demo dashboard
    9400 spark-exporter     -> job `spark`,       spark dashboard

A dashboard is offered only when its metric family is present in `/metrics`
(for example `node_uname_info` with `sysname="Darwin"` for the macOS dashboard,
or `spark_` families for the Spark dashboard). Host identity comes from
`node_uname_info{nodename}`, else the reverse DNS name, else the address; the
phone exporter is always local (`phone`).

Usage:

    python3 tools/discover_hosts.py --host 192.168.1.20
    python3 tools/discover_hosts.py --prometheus http://192.168.1.20:9090 \
        --ignition /tmp/ignition.json

The Ignition document is the one C-001 accepts: dashboards first (the phone
dashboard, then discovered ones), collector enabled, canonical targets.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


PHONE_DASHBOARD = "http://androdash.local/dashboards/phone-dashboard.json"

#: port -> (job, dashboard file, metric families that prove the exporter)
EXPORTERS = {
    9100: ("node", "macos-node-dashboard.json", ("node_uname_info",)),
    9106: ("agenticmac", "agenticmac-dashboard.json", ("agent_",)),
    9091: ("demo", "demo-dashboard.json", ("demo_",)),
    9400: ("spark", "spark-dashboard.json", ("spark_",)),
}

#: Dashboard preference when one host answers on several ports, and the order
#: the phone pages through. The phone dashboard is always first.
DASHBOARD_ORDER = ("phone", "macos-node", "agenticmac", "demo", "spark")

MAX_HOSTS = 32
MAX_DASHBOARDS = 8
MAX_METRICS_BYTES = 4 * 1024 * 1024
IPV4 = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


@dataclass(frozen=True)
class Exporter:
    """One reachable exporter and what it can serve."""

    address: str
    port: int
    job: str
    dashboard: str
    hostname: str
    sysname: str | None = None
    source: str = "host"


@dataclass
class Report:
    exporters: list[Exporter] = field(default_factory=list)
    unreachable: list[tuple[str, int]] = field(default_factory=list)

    def target(self, exporter: Exporter) -> str:
        """Canonical C-001 `collector_targets` entry for [exporter]."""
        instance = exporter.hostname or exporter.address
        return f"{exporter.job}:{instance}={exporter.address}:{exporter.port}"


def parse_arp(text: str) -> list[str]:
    """IPv4 addresses from `arp -an` output (macOS and Linux formats)."""
    found: list[str] = []
    for line in text.splitlines():
        if "incomplete" in line or "ff:ff:ff:ff:ff:ff" in line:
            continue
        for address in IPV4.findall(line):
            if address not in found and not address.startswith("224.") and not address.startswith("239."):
                found.append(address)
    return found


def parse_tailscale(text: str) -> list[str]:
    """Tailnet IPv4 addresses from `tailscale status` output."""
    found: list[str] = []
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0].startswith("100.") and parts[0] not in found:
            found.append(parts[0])
    return found


def parse_prometheus_targets(text: str) -> list[str]:
    """Host addresses of the active targets in a Prometheus `/api/v1/targets`.

    Loopback targets are dropped: they name the Prometheus host itself, which
    the phone cannot reach through that address.
    """
    try:
        data = json.loads(text)["data"]["activeTargets"]
    except (ValueError, KeyError, TypeError):
        return []
    found: list[str] = []
    for target in data:
        scrape = str(target.get("scrapeUrl", ""))
        host = re.sub(r"^[a-z]+://", "", scrape).split("/", 1)[0]
        host = host.rsplit(":", 1)[0] if ":" in host and not host.startswith("[") else host
        if not host or host in found or host in LOOPBACK:
            continue
        found.append(host)
    return found


def metric_identity(text: str) -> tuple[str | None, str | None]:
    """(nodename, sysname) from `node_uname_info`, when present."""
    for line in text.splitlines():
        if line.startswith("node_uname_info{"):
            nodename = _label(line, "nodename")
            sysname = _label(line, "sysname")
            return nodename, sysname
    return None, None


def has_family(text: str, families: Iterable[str]) -> bool:
    """True when `/metrics` carries at least one sample of a family prefix."""
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name = line.split("{", 1)[0].split(" ", 1)[0]
        for family in families:
            if name == family or name.startswith(family):
                return True
    return False


def _label(line: str, name: str) -> str | None:
    match = re.search(rf'{name}="([^"]*)"', line)
    return match.group(1) or None if match else None


def resolve_name(address: str) -> str | None:
    """First label of the reverse DNS name, or None."""
    try:
        name = socket.gethostbyaddr(address)[0]
    except (OSError, socket.herror):
        return None
    label = name.split(".", 1)[0].strip().lower()
    return label if re.fullmatch(r"[a-z0-9_.-]{1,64}", label) else None


def probe(address: str, port: int, timeout: float) -> str | None:
    """`/metrics` text when [address]:[port] answers, else None."""
    url = f"http://{address}:{port}/metrics"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            return response.read(MAX_METRICS_BYTES).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def classify(address: str, port: int, text: str, source: str) -> Exporter | None:
    """The [Exporter] for a `/metrics` body, or None when it is not one of ours."""
    job, dashboard, families = EXPORTERS[port]
    if not has_family(text, families):
        return None
    nodename, sysname = metric_identity(text)
    if port == 9100 and sysname != "Darwin":
        # The macOS dashboard reads Darwin-only node_exporter families.
        return None
    hostname = nodename or resolve_name(address) or address
    return Exporter(address=address, port=port, job=job, dashboard=dashboard,
                    hostname=hostname, sysname=sysname, source=source)


def discover(addresses: list[str], timeout: float = 1.5, sources: dict[str, str] | None = None) -> Report:
    """Probe every address on every exporter port, deterministically."""
    report = Report()
    sources = sources or {}
    jobs = [(address, port) for address in addresses for port in EXPORTERS]
    results: dict[tuple[str, int], str | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(64, max(1, len(jobs)))) as pool:
        futures = {pool.submit(probe, address, port, timeout): (address, port) for address, port in jobs}
        for future in concurrent.futures.as_completed(futures):
            address, port = futures[future]
            results[(address, port)] = future.result()
    for address, port in jobs:
        text = results[(address, port)]
        if text is None:
            report.unreachable.append((address, port))
            continue
        exporter = classify(address, port, text, sources.get(address, "host"))
        if exporter is not None:
            report.exporters.append(exporter)
    report.exporters.sort(key=lambda item: (DASHBOARD_ORDER.index(_dashboard_key(item)), item.address, item.port))
    return report


def _dashboard_key(exporter: Exporter) -> str:
    return exporter.dashboard.split("-dashboard", 1)[0]


def ignition_document(report: Report, *, layout_mode: str = "fit") -> dict:
    """The C-001 Ignition document for [report].

    The phone dashboard comes first (it always has data while the collector
    runs), then one dashboard per discovered exporter in DASHBOARD_ORDER. The
    collector is enabled, the phone exporter included, and the targets are the
    canonical `collector_targets` string.
    """
    dashboards: list[str] = [PHONE_DASHBOARD]
    targets: list[str] = []
    seen_jobs: set[tuple[str, str]] = set()
    for exporter in report.exporters:
        if len(dashboards) >= MAX_DASHBOARDS:
            break
        url = f"http://androdash.local/dashboards/{exporter.dashboard}"
        if url not in dashboards:
            dashboards.append(url)
        key = (exporter.job, exporter.hostname or exporter.address)
        if key not in seen_jobs and len(targets) < MAX_HOSTS:
            seen_jobs.add(key)
            targets.append(report.target(exporter))
    return {
        "schemaVersion": 1,
        "dashboards": {"urls": dashboards, "current": PHONE_DASHBOARD},
        "collector": {
            "enabled": True,
            "phone": True,
            "targets": ",".join(targets),
        },
        "layoutMode": layout_mode,
    }


def validate_ignition(doc: dict) -> list[str]:
    """The strict C-001 rules a document must satisfy; returns the problems."""
    problems: list[str] = []
    allowed = {"schemaVersion", "dashboards", "collector", "prometheusUrl", "layoutMode",
               "displayMode", "lockStyle", "refreshSeconds", "timeRange", "rotateSeconds",
               "kiosk", "debug"}
    for key in doc:
        if key not in allowed:
            problems.append(f"unknown key {key}")
    dashboards = doc.get("dashboards")
    if not isinstance(dashboards, dict):
        problems.append("dashboards must be an object")
    else:
        urls = dashboards.get("urls")
        if not isinstance(urls, list) or not 1 <= len(urls) <= MAX_DASHBOARDS:
            problems.append(f"dashboards.urls must hold 1 to {MAX_DASHBOARDS} URLs")
        elif len(set(urls)) != len(urls):
            problems.append("dashboards.urls repeats a URL")
        for url in urls if isinstance(urls, list) else []:
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                problems.append(f"dashboards.urls entry {url!r} is not an absolute http(s) URL")
        current = dashboards.get("current")
        if current is not None and current not in (urls or []):
            problems.append("dashboards.current must be one of dashboards.urls")
    collector = doc.get("collector")
    if not isinstance(collector, dict):
        problems.append("collector must be an object")
    else:
        targets = collector.get("targets", "")
        if not isinstance(targets, str):
            problems.append("collector.targets must be a string")
        elif targets:
            entries = [entry.strip() for entry in targets.split(",") if entry.strip()]
            if len(entries) > MAX_HOSTS:
                problems.append(f"collector.targets must hold at most {MAX_HOSTS} entries")
            seen: set[tuple[str, str]] = set()
            for entry in entries:
                job, instance, address = _split_target(entry)
                if address is None:
                    problems.append(f"collector target {entry!r} is not [job:]instance=host:port or host:port")
                    continue
                if (job, instance) in seen:
                    problems.append(f"collector target {entry!r} repeats a job and instance")
                seen.add((job, instance))
        phone = collector.get("phone", True)
        enabled = collector.get("enabled", False)
        if enabled and not targets and not phone:
            problems.append("collector=true needs collector.targets or collector.phone=true")
    return problems


def _split_target(entry: str) -> tuple[str, str, str | None]:
    """(job, instance, address) for a canonical target, address None when invalid."""
    job, instance = "node", entry
    if "=" in entry:
        labels, _, address = entry.partition("=")
        job_part, _, instance_part = labels.partition(":")
        job = job_part or "node"
        instance = instance_part or address
    else:
        address = entry
    match = re.fullmatch(r"([A-Za-z0-9_.:-]{1,253}):([1-9][0-9]{0,4})", address)
    if not match:
        return job, instance, None
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", job) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", instance):
        return job, instance, None
    return job, instance, address


def candidates(args: argparse.Namespace) -> list[tuple[str, str]]:
    """(address, source) pairs from every requested source, deduplicated."""
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(address: str, source: str) -> None:
        if address and address not in seen:
            seen.add(address)
            pairs.append((address, source))

    for address in args.host or []:
        add(address, "host")
    if args.prometheus:
        text = _fetch(f"{args.prometheus.rstrip('/')}/api/v1/targets?state=active", args.timeout)
        for address in parse_prometheus_targets(text or ""):
            add(address, "prometheus")
    if not args.no_lan:
        try:
            text = subprocess.run(["arp", "-an"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            text = ""
        for address in parse_arp(text):
            add(address, "lan")
    if not args.no_tailnet:
        try:
            text = subprocess.run(["tailscale", "status"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            text = ""
        for address in parse_tailscale(text):
            add(address, "tailnet")
    return pairs


def _fetch(url: str, timeout: float) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read(MAX_METRICS_BYTES).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", action="append", help="address or hostname to probe (repeatable)")
    parser.add_argument("--prometheus", help="Prometheus base URL whose active targets are probed")
    parser.add_argument("--no-lan", action="store_true", help="skip the ARP table")
    parser.add_argument("--no-tailnet", action="store_true", help="skip `tailscale status`")
    parser.add_argument("--timeout", type=float, default=1.5, help="per-probe timeout in seconds")
    parser.add_argument("--layout-mode", default="fit", choices=["auto", "grid", "stack", "fit"])
    parser.add_argument("--ignition", type=Path, help="write the Ignition document here")
    parser.add_argument("--json", action="store_true", help="print the discovery report as JSON")
    args = parser.parse_args(argv)

    pairs = candidates(args)
    if not pairs:
        print("no candidate hosts: pass --host or --prometheus, or check the LAN", file=sys.stderr)
        return 2
    report = discover([address for address, _ in pairs], timeout=args.timeout, sources=dict(pairs))

    if args.json:
        print(json.dumps({
            "hosts": [
                {
                    "address": exporter.address,
                    "port": exporter.port,
                    "job": exporter.job,
                    "dashboard": exporter.dashboard,
                    "hostname": exporter.hostname,
                    "sysname": exporter.sysname,
                    "source": exporter.source,
                    "target": report.target(exporter),
                }
                for exporter in report.exporters
            ],
            "unreachable": len(report.unreachable),
        }, indent=2, sort_keys=True))
    else:
        print(f"probed {len(pairs)} hosts x {len(EXPORTERS)} ports")
        for exporter in report.exporters:
            print(f"  {exporter.address}:{exporter.port}  {exporter.job:<10} "
                  f"{exporter.hostname:<16} {exporter.dashboard}  ({exporter.source})")
        if not report.exporters:
            print("  no supported exporter answered")

    if args.ignition:
        doc = ignition_document(report, layout_mode=args.layout_mode)
        problems = validate_ignition(doc)
        if problems:
            for problem in problems:
                print(f"ignition: {problem}", file=sys.stderr)
            return 1
        args.ignition.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        print(f"ignition: {args.ignition} ({len(doc['dashboards']['urls'])} dashboards)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

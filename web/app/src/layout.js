export function resolveLayoutMode(mode, width) {
  if (mode === "grid") return "grid";
  if (mode === "stack") return "stack";
  return width >= 900 ? "grid" : "stack";
}

/**
 * Panel kinds whose stack slot is sized by their content instead of the
 * height-derived slot (C-005). Stat tiles are a few text rows; a fixed
 * height-derived slot wasted more than half of it. Tables, Markdown, charts,
 * and gauges keep the slot so long content scrolls instead of growing.
 */
const CONTENT_HEIGHT_KINDS = new Set(["StatChart"]);

export function panelHeight(item, mode) {
  if (mode === "grid") return Math.max(140, item.height * 30 + (item.height - 1) * 8);
  return Math.max(160, item.height * 24);
}

export function orderedItems(items) {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Split a row's grid items into horizontal bands (C-005 pagination). Items
 * whose vertical extents overlap sit side by side in the dashboard, so they
 * form one band; a band with two or more items pages horizontally on a phone,
 * a band with one item stays in the vertical stack. Items inside a band are
 * ordered by column, then by y, which is the reading order of a swipe.
 */
export function bandItems(items) {
  const bands = [];
  for (const item of orderedItems(items)) {
    const band = bands.at(-1);
    if (band && item.y < band.bottom) {
      band.items.push(item);
      band.bottom = Math.max(band.bottom, item.y + item.height);
    } else {
      bands.push({ top: item.y, bottom: item.y + item.height, items: [item] });
    }
  }
  for (const band of bands) band.items.sort((a, b) => a.x - b.x || a.y - b.y);
  return bands;
}

function setCollapsed(section, header, body, collapsed) {
  section.dataset.rowCollapsed = String(collapsed);
  header.setAttribute("aria-expanded", String(!collapsed));
  body.hidden = collapsed;
}

function collapseButton(row) {
  const header = document.createElement("button");
  header.type = "button";
  header.className = "row-header";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = row.title || "Overview";
  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  header.append(title, chevron);
  return header;
}

function panelSlot(item, createPanel) {
  const panel = createPanel(item);
  if (!panel) return null;
  const slot = document.createElement("div");
  slot.className = "panel-slot";
  slot.style.setProperty("--panel-height-grid", `${panelHeight(item, "grid")}px`);
  slot.style.setProperty("--panel-height-stack", `${panelHeight(item, "stack")}px`);
  slot.dataset.contentHeight = String(CONTENT_HEIGHT_KINDS.has(item.panel?.panelKind));
  slot.style.gridColumn = `${item.x + 1} / span ${item.width}`;
  slot.style.gridRow = `${item.y + 1} / span ${item.height}`;
  slot.append(panel);
  return slot;
}

/**
 * A horizontally paged band. In grid mode the strip is `display: contents`, so
 * its slots are ordinary grid children; in stack mode it is a scroll-snap
 * carousel with one page dot per panel. Dots track the visible page through an
 * IntersectionObserver, so nothing runs while the strip is still.
 */
function panelStrip(slots, rowTitle) {
  const strip = document.createElement("div");
  strip.className = "panel-strip";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-roledescription", "carousel");
  strip.setAttribute("aria-label", `${rowTitle || "Panels"}: ${slots.length} pages, swipe sideways`);
  strip.append(...slots);

  const dots = document.createElement("div");
  dots.className = "strip-dots";
  const buttons = slots.map((slot, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "strip-dot";
    const title = slot.querySelector?.(".panel-title")?.textContent || `panel ${index + 1}`;
    dot.setAttribute("aria-label", `Show ${title}`);
    dot.dataset.active = String(index === 0);
    dot.addEventListener("click", () => {
      strip.scrollTo?.({ left: slot.offsetLeft - strip.offsetLeft, behavior: "smooth" });
    });
    return dot;
  });
  dots.append(...buttons);

  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.indexOf(entry.target);
          buttons.forEach((dot, dotIndex) => {
            dot.dataset.active = String(dotIndex === index);
          });
        }
      },
      { root: strip, threshold: 0.6 },
    );
    for (const slot of slots) observer.observe(slot);
  }
  return [strip, dots];
}

/**
 * Build the dashboard rows. Panel DOM nodes are supplied by the caller so this
 * module only owns responsive placement, paging, and collapse behavior.
 */
export function renderRows(rows, { createPanel }) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const section = document.createElement("section");
    section.className = "row";
    section.dataset.rowTitle = row.title || "";

    const header = collapseButton(row);
    const body = document.createElement("div");
    body.className = "row-body";
    setCollapsed(section, header, body, Boolean(row.collapsed));
    header.addEventListener("click", () => {
      setCollapsed(section, header, body, section.dataset.rowCollapsed !== "true");
    });

    for (const band of bandItems(row.items)) {
      const slots = band.items.map((item) => panelSlot(item, createPanel)).filter(Boolean);
      if (slots.length === 1) body.append(slots[0]);
      else if (slots.length > 1) body.append(...panelStrip(slots, row.title));
    }

    section.append(header, body);
    fragment.append(section);
  }
  return fragment;
}

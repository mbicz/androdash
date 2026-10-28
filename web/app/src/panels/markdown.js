const MAX_TEXT = 100_000;

function appendInline(parent, text) {
  let rest = text;
  while (rest.length > 0) {
    const patterns = [
      { re: /`([^`]+)`/, type: "code" },
      { re: /\*\*([^*]+)\*\*/, type: "strong" },
      { re: /\[([^\]]+)\]\(([^)]+)\)/, type: "link" },
      { re: /\*([^*]+)\*/, type: "em" },
    ];
    let first = null;
    for (const pattern of patterns) {
      const match = pattern.re.exec(rest);
      if (match && (!first || match.index < first.match.index)) {
        first = { ...pattern, match };
      }
    }
    if (!first) {
      parent.append(document.createTextNode(rest));
      break;
    }
    if (first.match.index > 0) {
      parent.append(document.createTextNode(rest.slice(0, first.match.index)));
    }
    if (first.type === "code") {
      const code = document.createElement("code");
      code.textContent = first.match[1];
      parent.append(code);
    } else if (first.type === "strong") {
      const strong = document.createElement("strong");
      appendInline(strong, first.match[1]);
      parent.append(strong);
    } else if (first.type === "em") {
      const em = document.createElement("em");
      appendInline(em, first.match[1]);
      parent.append(em);
    } else {
      parent.append(document.createTextNode(`${first.match[1]} (${first.match[2]})`));
    }
    rest = rest.slice(first.match.index + first.match[0].length);
  }
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

export function renderMarkdown(panel) {
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-body";
  const raw = typeof panel.panelSpec?.text === "string" ? panel.panelSpec.text : "";
  const text = raw.slice(0, MAX_TEXT);
  if (text.trim().length === 0) {
    wrapper.dataset.empty = "true";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No content";
    wrapper.append(empty);
    return wrapper;
  }
  wrapper.dataset.empty = "false";

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      wrapper.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      wrapper.append(element);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      wrapper.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const cell of splitTableRow(line)) {
        const th = document.createElement("th");
        appendInline(th, cell);
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);
      const tbody = document.createElement("tbody");
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        const tr = document.createElement("tr");
        for (const cell of splitTableRow(lines[index])) {
          const td = document.createElement("td");
          appendInline(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
        index += 1;
      }
      table.append(tbody);
      wrapper.append(table);
      continue;
    }

    const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[2]);
        list.append(li);
        index += 1;
      }
      wrapper.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() !== "") {
      if (
        /^\s*```/.test(lines[index]) ||
        /^(#{1,6})\s+/.test(lines[index]) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) ||
        /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])
      ) {
        break;
      }
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length > 0) {
      const paragraph = document.createElement("p");
      appendInline(paragraph, paragraphLines.join(" "));
      wrapper.append(paragraph);
    } else {
      index += 1;
    }
  }

  return wrapper;
}

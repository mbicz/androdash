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

function collapseButton(row) {
  const header = document.createElement("button");
  header.type = "button";
  header.className = "row-header";
  header.setAttribute("aria-expanded", String(!row.collapsed));
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = row.title || "Overview";
  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  header.append(title, chevron);
  header.addEventListener("click", () => {
    const collapsed = section.dataset.rowCollapsed === "true";
    section.dataset.rowCollapsed = String(!collapsed);
    header.setAttribute("aria-expanded", String(collapsed));
    body.hidden = !collapsed;
  });
  return header;
}

/**
 * Build the dashboard rows. Panel DOM nodes are supplied by the caller so this
 * module only owns responsive placement and collapse behavior.
 */
export function renderRows(rows, { mode, createPanel }) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const section = document.createElement("section");
    section.className = "row";
    section.dataset.rowTitle = row.title || "";
    section.dataset.rowCollapsed = String(row.collapsed);

    const header = collapseButton(row);
    const body = document.createElement("div");
    body.className = "row-body";
    body.hidden = row.collapsed;

    for (const item of orderedItems(row.items)) {
      const slot = document.createElement("div");
      slot.className = "panel-slot";
      slot.style.setProperty("--panel-height-grid", `${panelHeight(item, "grid")}px`);
      slot.style.setProperty("--panel-height-stack", `${panelHeight(item, "stack")}px`);
      slot.dataset.contentHeight = String(
        CONTENT_HEIGHT_KINDS.has(item.panel?.panelKind),
      );
      slot.style.gridColumn = `${item.x + 1} / span ${item.width}`;
      slot.style.gridRow = `${item.y + 1} / span ${item.height}`;
      const panel = createPanel(item);
      if (panel) {
        slot.append(panel);
        body.append(slot);
      }
    }

    section.append(header, body);
    fragment.append(section);
  }
  return fragment;
}

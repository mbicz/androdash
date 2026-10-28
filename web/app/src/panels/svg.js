const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl(name, attributes = {}, children = []) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    element.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined) element.append(child);
  }
  return element;
}

export function svgText(text, attributes = {}) {
  const element = svgEl("text", attributes);
  element.textContent = text;
  return element;
}

export function polar(cx, cy, radius, angleDegrees) {
  const radians = (angleDegrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

export function arcPath(cx, cy, radius, startDegrees, endDegrees) {
  const start = polar(cx, cy, radius, startDegrees);
  const end = polar(cx, cy, radius, endDegrees);
  const large = Math.abs(endDegrees - startDegrees) > 180 ? 1 : 0;
  const sweep = endDegrees > startDegrees ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function linePath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

export function clear(element) {
  if (element) element.replaceChildren();
}

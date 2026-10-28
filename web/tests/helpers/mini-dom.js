/**
 * A deliberately tiny DOM for renderer tests. It implements only the browser
 * surface the panel builders use; it is not a browser emulator.
 */
class MiniNode {
  constructor(tagName, { text = false } = {}) {
    this.tagName = text ? "#text" : String(tagName).toUpperCase();
    this.nodeType = text ? 3 : 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
    this.className = "";
    this.id = "";
    this.type = "";
    this.title = "";
    this.hidden = false;
    this._text = text ? String(tagName) : "";
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) values.add(name);
        this.className = [...values].join(" ");
      },
      remove: (...names) => {
        const remove = new Set(names);
        this.className = this.className
          .split(/\s+/)
          .filter((name) => name && !remove.has(name))
          .join(" ");
      },
      toggle: (name, force) => {
        const has = this.className.split(/\s+/).includes(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) this.classList.add(name);
        else this.classList.remove(name);
        return next;
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (node.nodeType === 11) {
        this.append(...node.children);
        continue;
      }
      if (typeof node === "string") {
        this.append(document.createTextNode(node));
        continue;
      }
      node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = value === null || value === undefined ? "" : String(value);
      return;
    }
    this.children = [];
    if (value !== null && value !== undefined) this.append(document.createTextNode(String(value)));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    const list = this._listeners.get(type) || [];
    list.push(listener);
    this._listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((item) => item !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this._listeners.get(type) || []) listener(event);
  }

  matches(selector) {
    if (selector === "*") return true;
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const [tag, ...classes] = selector.split(".");
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    return classes.every((name) => this.classList.contains(name));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/).filter(Boolean);
    const result = [];
    const walk = (node, partIndex) => {
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (child.matches(parts[partIndex])) {
          if (partIndex === parts.length - 1) result.push(child);
          else walk(child, partIndex + 1);
        }
        walk(child, partIndex);
      }
    };
    if (parts.length === 0) return result;
    walk(this, 0);
    return result;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  focus() {}

  click() {
    this.dispatch("click", { target: this });
  }
}

class MiniDocumentFragment extends MiniNode {
  constructor() {
    super("#fragment");
    this.nodeType = 11;
  }
}

export function installMiniDom() {
  const document = {
    createElement(tag) {
      return new MiniNode(tag);
    },
    createElementNS(_namespace, tag) {
      return new MiniNode(tag);
    },
    createTextNode(text) {
      return new MiniNode(text, { text: true });
    },
    createDocumentFragment() {
      return new MiniDocumentFragment();
    },
    body: new MiniNode("body"),
    documentElement: new MiniNode("html"),
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  globalThis.document = document;
  globalThis.MiniNode = MiniNode;
  return document;
}

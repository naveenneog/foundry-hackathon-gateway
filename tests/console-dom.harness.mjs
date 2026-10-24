/**
 * A small fake DOM for the Key Dashboard's browser modules under Node. Elements have attributes,
 * classes, a selector subset (tag, .class, [attr], [attr="v"], :not(...), :checked and comma
 * lists), bubbling events, focus, <details> and modal <dialog>. A selector outside that subset
 * throws, so a test never passes on a query the fake silently ignored.
 */

export const fakeEvent = (type, init = {}) => ({
  type, target: null, currentTarget: null, bubbles: true, defaultPrevented: false, stopped: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init,
});
export const keydown = (key, init = {}) => fakeEvent("keydown", { key, ...init });

const COMPOUND = /^([a-z][a-z0-9-]*)?((?:\.[\w-]+|\[[a-z-]+(?:="[^"]*")?\]|:not\([^()]+\)|:checked)*)$/i;
const PART = /\.([\w-]+)|\[([a-z-]+)(?:="([^"]*)")?\]|:not\(([^()]+)\)|(:checked)/gi;

function matchesCompound(node, selector) {
  const m = COMPOUND.exec(selector);
  if (!selector || !m) throw new Error(`The fake DOM does not support "${selector}".`);
  if (m[1] && node.tagName !== m[1].toLowerCase()) return false;
  for (const [, cls, attr, value, not, checked] of m[2].matchAll(PART)) {
    if (cls !== undefined && !node.classList.contains(cls)) return false;
    if (attr !== undefined && (!node.hasAttribute(attr) || (value !== undefined && node.getAttribute(attr) !== value))) return false;
    if (not !== undefined && matchesCompound(node, not.trim())) return false;
    if (checked !== undefined && node.checked !== true) return false;
  }
  return true;
}
const matches = (node, selector) => selector.split(",").some((s) => matchesCompound(node, s.trim()));

/** Enough DOM for el(), the guide panel, highlights, views, dialogs, focus and bubbling events. */
export function fakeDom() {
  let focused = null;
  // As in a browser, focus on an element that has been removed falls back to <body>.
  const doc = { listeners: {}, get activeElement() { return focused?.isConnected ? focused : doc.body; } };
  const below = (node, out = []) => {
    for (const c of node.children) if (c.nodeType === 1) { out.push(c); below(c, out); }
    return out;
  };
  const detach = (n) => {
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = null;
  };
  const flag = (attrs, name) => ({
    get() { return attrs.has(name); },
    set(v) { if (v) attrs.set(name, ""); else attrs.delete(name); },
    enumerable: true,
  });
  const make = (tag) => {
    const attrs = new Map();
    const node = {
      nodeType: 1, tagName: tag.toLowerCase(), children: [], parentNode: null, listeners: {}, checked: false, value: "", modal: false,
      setAttribute: (k, v) => { attrs.set(k, String(v)); },
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => { attrs.delete(k); },
      hasAttribute: (k) => attrs.has(k),
      toggleAttribute: (k, force = !attrs.has(k)) => { if (force) attrs.set(k, ""); else attrs.delete(k); return force; },
      classList: {
        list: () => (attrs.get("class") ?? "").split(/\s+/).filter(Boolean),
        add(...names) { attrs.set("class", [...new Set([...this.list(), ...names])].join(" ")); },
        remove(...names) { attrs.set("class", this.list().filter((c) => !names.includes(c)).join(" ")); },
        contains(name) { return this.list().includes(name); },
        toggle(name, on = !this.contains(name)) { if (on) this.add(name); else this.remove(name); return on; },
      },
      append: (...nodes) => { for (const n of nodes) { detach(n); n.parentNode = node; node.children.push(n); } },
      replaceChildren: (...nodes) => { for (const c of [...node.children]) detach(c); node.append(...nodes); },
      remove: () => detach(node),
      contains: (n) => { for (let x = n; x; x = x.parentNode) if (x === node) return true; return false; },
      get isConnected() { for (let x = node; x; x = x.parentNode) if (x === doc.body) return true; return false; },
      get firstElementChild() { return node.children.find((c) => c.nodeType === 1) ?? null; },
      get textContent() { return node.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(""); },
      set textContent(v) { node.replaceChildren(doc.createTextNode(v)); },
      querySelectorAll: (s) => below(node).filter((n) => matches(n, s)),
      querySelector: (s) => node.querySelectorAll(s)[0] ?? null,
      addEventListener: (type, fn, options) => {
        const listener = options?.once ? Object.assign((e) => { node.removeEventListener(type, fn); fn(e); }, { original: fn }) : fn;
        (node.listeners[type] ??= []).push(listener);
      },
      removeEventListener: (type, fn) => { node.listeners[type] = (node.listeners[type] ?? []).filter((f) => f !== fn && f.original !== fn); },
      dispatchEvent(event) {
        event.target ??= node;
        for (let x = node; x && !event.stopped; x = event.bubbles ? x.parentNode : null) {
          event.currentTarget = x;
          for (const fn of [...(x.listeners[event.type] ?? [])]) fn(event);
        }
        if (!event.stopped && event.bubbles) for (const fn of [...(doc.listeners[event.type] ?? [])]) fn(event);
        return !event.defaultPrevented;
      },
      click: () => { if (!node.disabled) node.dispatchEvent(fakeEvent("click")); },
      focus: (options) => { focused = node; node.focusOptions = options; },
      scrollIntoView: (options) => { node.scrolledWith = options; },
      /** Rendered boxes: none when hidden, inside a closed dialog or a closed <details> (its summary aside), or detached. */
      getClientRects() {
        for (let x = node; x; x = x.parentNode) {
          if (x.hasAttribute("hidden") || (x.tagName === "dialog" && !x.open)) return [];
          if (x.parentNode?.tagName === "details" && !x.parentNode.open && x.tagName !== "summary") return [];
        }
        return node.isConnected ? [{}] : [];
      },
      showModal() {
        attrs.set("open", "");
        node.modal = true;
      },
      close() {
        if (!attrs.has("open")) return;
        attrs.delete("open");
        node.modal = false;
        node.dispatchEvent(fakeEvent("close", { bubbles: false }));
      },
    };
    Object.defineProperties(node, { hidden: flag(attrs, "hidden"), disabled: flag(attrs, "disabled"), open: flag(attrs, "open"),
      // As in a browser, the id property reflects the attribute ("" when there is none).
      id: { get: () => attrs.get("id") ?? "", set: (v) => attrs.set("id", String(v)), enumerable: true } });
    return node;
  };
  Object.assign(doc, {
    createElement: make,
    createElementNS: (_ns, tag) => make(tag),
    createTextNode: (data) => ({ nodeType: 3, data: String(data), parentNode: null }),
    addEventListener: (type, fn) => { (doc.listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { doc.listeners[type] = (doc.listeners[type] ?? []).filter((f) => f !== fn); },
    querySelector: (s) => doc.body.querySelector(s),
    querySelectorAll: (s) => doc.body.querySelectorAll(s),
    getElementById: (id) => below(doc.body).find((n) => n.getAttribute("id") === id) ?? null,
  });
  doc.body = make("body");
  return doc;
}

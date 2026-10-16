// Key Console front end. No framework, no inline script (CSP: script-src 'self'), and data is only
// ever written with textContent — never innerHTML — so key metadata cannot inject markup.

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const state = { me: null, config: null, keys: [], selected: new Set() };

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function flash(message, isError = false) {
  const f = $("#flash");
  f.textContent = message;
  f.className = isError ? "flash error" : "flash";
  f.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { f.hidden = true; }, isError ? 12000 : 6000);
}

const busy = (fn) => async (ev) => {
  ev?.preventDefault?.();
  const btn = ev?.submitter ?? ev?.currentTarget;
  if (btn && "disabled" in btn) btn.disabled = true;
  try {
    await fn(ev);
  } catch (e) {
    flash(e.message, true);
  } finally {
    if (btn && "disabled" in btn) btn.disabled = false;
  }
};

const isAdmin = () => state.me?.role === "admin";
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function showTab(name) {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.id !== `tab-${name}`;
}

function statusPill(k) {
  if (k.kind === "jwt") {
    if (k.revoked === "true") return el("span", { class: "pill bad" }, "revoked");
    if (k.expires && Date.parse(k.expires) < Date.now()) return el("span", { class: "pill mid" }, "expired");
    return el("span", { class: "pill" }, "active");
  }
  if (k.state === "suspended") return el("span", { class: "pill bad" }, "suspended");
  return el("span", { class: "pill" }, k.rotateDays ? `active · auto ${k.rotateDays}d` : "active");
}

function actionsFor(k) {
  const out = [el("button", { class: "small secondary", onclick: busy(() => reveal(k.name)) }, "Reveal")];
  if (!isAdmin()) return out;
  if (k.kind === "jwt" && k.revoked !== "true") {
    out.push(el("button", { class: "small danger", onclick: busy(async () => {
      if (!confirm(`Revoke ${k.subject ?? k.name}? The gateway refuses it immediately.`)) return;
      await api(`/api/keys/${k.name}/revoke`, {});
      flash(`Revoked ${k.name}.`);
      await loadKeys();
    }) }, "Revoke"));
  }
  if (k.kind === "product" && k.slot) {
    out.push(el("button", { class: "small", onclick: busy(async () => {
      const r = await api(`/api/keys/${k.name}/rotate`, {});
      flash(`Rotated ${k.name}: clients should now use the ${r.slot} key; the previous key keeps working until the next rotation.`);
      await loadKeys();
    }) }, "Rotate"));
    const next = k.state === "suspended" ? "active" : "suspended";
    out.push(el("button", { class: `small ${next === "suspended" ? "warn" : "secondary"}`, onclick: busy(async () => {
      await api(`/api/keys/${k.name}/state`, { state: next });
      flash(`${k.name} is now ${next}.`);
      await loadKeys();
    }) }, next === "suspended" ? "Suspend" : "Resume"));
    out.push(el("button", { class: "small secondary", onclick: busy(async () => {
      const v = prompt("Rotate automatically every how many days (1–90)? Leave blank to switch automation off.", k.rotateDays ?? "30");
      if (v === null) return;
      const r = await api(`/api/keys/${k.name}/automation`, { rotateDays: v.trim() === "" ? null : Number(v) });
      flash(r.rotateDays ? `Automation on: every ${r.rotateDays} days.` : "Automation off.");
      await loadKeys();
    }) }, "Automation"));
  }
  return out;
}

function grantOf(k) {
  if (k.kind === "jwt") return `${k.subject ?? ""} · ${k.models ?? ""} · ${Number(k.budget ?? 0).toLocaleString()} tokens`;
  return `${k.product ?? ""}${k.slot ? ` · ${k.slot} slot` : ""}`;
}

function renderKeys() {
  const body = $("#keys-body");
  body.replaceChildren();
  if (state.keys.length === 0) {
    body.append(el("tr", {}, el("td", { colspan: 8, class: "hint" }, isAdmin() ? "No keys yet. Issue one from the tabs above." : "No keys have been issued to you yet.")));
  }
  for (const k of state.keys) {
    const pick = el("input", { type: "checkbox", "aria-label": `Select ${k.name} for export` });
    pick.checked = state.selected.has(k.name);
    pick.addEventListener("change", () => {
      pick.checked ? state.selected.add(k.name) : state.selected.delete(k.name);
      renderSelection();
    });
    body.append(el("tr", {},
      isAdmin() ? el("td", {}, pick) : null,
      el("td", { class: "mono" }, k.name),
      el("td", {}, k.kind === "jwt" ? "signed" : "product"),
      el("td", {}, k.owner ?? "—"),
      el("td", {}, grantOf(k)),
      el("td", {}, k.kind === "jwt" ? `until ${fmt(k.expires)}` : `rotated ${fmt(k.rotatedAt)}`),
      el("td", {}, statusPill(k)),
      el("td", {}, el("div", { class: "row" }, actionsFor(k)))));
  }
  $("#keys-hint").textContent = isAdmin()
    ? "You see every key. Tick keys to include them in an export bundle."
    : "You see only the keys issued to you. Reveal one to get its value and client setup.";
}

function renderSelection() {
  $("#export-count").textContent = String(state.selected.size);
  $("#export-names").textContent = [...state.selected].join(", ");
}

async function loadKeys() {
  state.keys = (await api("/api/keys")).keys;
  for (const n of [...state.selected]) if (!state.keys.some((k) => k.name === n)) state.selected.delete(n);
  renderKeys();
  renderSelection();
}

async function reveal(name) {
  const r = await api(`/api/keys/${encodeURIComponent(name)}`);
  $("#reveal-title").textContent = `${r.kind === "jwt" ? "Signed key" : "Product key"} ${name}`;
  $("#reveal-value").value = r.value;
  $("#reveal-handout").textContent = JSON.stringify(r.handout, null, 2);
  $("#reveal").showModal();
}

function secretBox(title, lines) {
  return el("div", { class: "secret-box" }, el("strong", {}, title), ...lines.map((l) => (l instanceof Node ? l : el("p", {}, l))));
}

function download(filename, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function loadSigning() {
  const s = await api("/api/signing");
  const dl = $("#signing-status");
  dl.replaceChildren(
    el("dt", {}, "In Key Vault"), el("dd", {}, s.vault ? "yes" : "no — migrate it"),
    el("dt", {}, "In API Management"), el("dd", {}, s.apim ? "yes" : "no"),
    el("dt", {}, "Same value"), el("dd", {}, s.inSync ? "yes" : "NO — keys minted here would be refused"));
}

function wireAdmin() {
  const boxes = $("#model-boxes");
  for (const [group, list] of [["OpenAI-compatible", state.config.models.openai], ["Claude", state.config.models.claude]]) {
    for (const m of list) boxes.append(el("label", {}, el("input", { type: "checkbox", name: "models", value: m }), `${m} (${group})`));
  }
  const sel = $("#product-select");
  for (const p of state.config.products) sel.append(el("option", { value: p }, p));

  $("#issue-form").addEventListener("submit", busy(async (ev) => {
    const f = new FormData(ev.target);
    const r = await api("/api/jwt", {
      owner: f.get("owner"), subject: f.get("subject"), models: f.getAll("models"),
      budget: Number(f.get("budget")), hours: Number(f.get("hours")), label: f.get("label") || undefined,
    });
    $("#issue-result").replaceChildren(secretBox(`Issued ${r.name} (expires ${fmt(new Date(r.expiresAt).toISOString())})`, [
      "The owner can reveal it from their Keys tab, or you can export it as a bundle.",
      el("pre", { class: "mono" }, JSON.stringify(r.handout, null, 2)),
    ]));
    ev.target.reset();
    await loadKeys();
  }));

  $("#product-form").addEventListener("submit", busy(async (ev) => {
    const f = new FormData(ev.target);
    const r = await api("/api/products", { owner: f.get("owner"), name: f.get("name"), product: f.get("product"), rotateDays: f.get("rotateDays") || null });
    flash(`Issued ${r.name} on ${r.product}. Its key is in Key Vault.`);
    ev.target.reset();
    await loadKeys();
  }));

  $("#export-form").addEventListener("submit", busy(async (ev) => {
    if (state.selected.size === 0) throw new Error("Select keys on the Keys tab first.");
    const f = new FormData(ev.target);
    const r = await api("/api/export", { names: [...state.selected], recipient: f.get("recipient"), passphrase: f.get("passphrase") || undefined });
    download(r.filename, r.bundle);
    $("#export-result").replaceChildren(secretBox(`Downloaded ${r.filename}`, r.passphrase
      ? ["Passphrase (shown once — send it by a different channel than the file):", el("pre", { class: "mono" }, r.passphrase)]
      : ["Encrypted with the passphrase you entered."]));
    ev.target.reset();
  }));

  $("#sweep").addEventListener("click", busy(async () => {
    const r = await api("/api/sweep", {});
    flash(`Automation: rotated ${r.rotated.length}${r.failed.length ? `, failed ${r.failed.join(", ")}` : ""}.`, r.failed.length > 0);
    await loadKeys();
  }));
  $("#sig-migrate").addEventListener("click", busy(async () => {
    const r = await api("/api/signing/migrate", {});
    flash(r.migrated ? "Signing secret copied into Key Vault." : "Key Vault already holds the same signing secret.");
    await loadSigning();
  }));
  $("#sig-push").addEventListener("click", busy(async () => {
    const word = prompt("Type PUSH to overwrite API Management's signing key with the vault's value.");
    if (word === null) return;
    await api("/api/signing/push", { confirm: word });
    flash("API Management now uses the vault's signing secret.");
    await loadSigning();
  }));
  $("#sig-rotate").addEventListener("click", busy(async () => {
    const word = prompt("Every signed key issued so far will stop working. Type ROTATE to continue.");
    if (word === null) return;
    await api("/api/signing/rotate", { confirm: word });
    flash("Signing secret rotated. Re-issue signed keys.");
    await loadSigning();
  }));
}

async function main() {
  try {
    state.me = await api("/api/me");
  } catch (e) {
    document.querySelector("main").replaceChildren(el("p", { class: "flash error" }, `${e.message} Ask an admin to assign you the Console.User or Console.Admin role.`));
    return;
  }
  $("#who-name").textContent = state.me.name;
  const badge = $("#who-role");
  badge.textContent = state.me.role;
  badge.classList.toggle("admin", isAdmin());
  if (!isAdmin()) for (const n of document.querySelectorAll("[data-admin]")) n.remove();

  for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === "signing") busy(loadSigning)();
  });
  $("#refresh").addEventListener("click", busy(loadKeys));
  $("#reveal-copy").addEventListener("click", busy(async () => {
    await navigator.clipboard.writeText($("#reveal-value").value);
    flash("Copied.");
  }));
  $("#reveal").addEventListener("close", () => { $("#reveal-value").value = ""; });

  state.config = await api("/api/config");
  if (isAdmin()) {
    wireAdmin();
    api("/api/bundle-key").then((k) => { $("#bundle-key").textContent = JSON.stringify(k, null, 2); }).catch(() => {});
  }
  await loadKeys();
}

main();

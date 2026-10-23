// Key Dashboard — issuing keys. Single and bulk, for both kinds, with an explicit "One model" /
// "Several models" choice. Short-lived keys grant pinned gateway aliases and may start later;
// product keys grant Foundry deployment names. Bulk rows come from pasted or uploaded CSV, are
// checked here, then sent in sequential batches of 50 through secret.js, which keeps the server's
// keys.csv and index.csv for download and hands this module rows without keys.

import { invalidate } from "./api.js";
import {
  addChildren, busy, confirmDialog, copyText, el, emailText, emptyState, errorState, field, icon, loadingState, reportError, routeBadge,
  segmented, setChildren, showErrors, toast, uid,
} from "./dom.js";
import {
  activeWindow, BATCH_SIZE, chunk, CsvError, entriesFromCsv, fmtDateTime, fmtInt, fmtShortDateTime, idField, KINDS, LIMITS, modelOptions,
  parseCsv, ROUTE_LABEL, toCsv, validateEntries, validateIssue, validateSettings,
} from "./lib.js";
import { createBulkCsv, issueKey, revealKey } from "./secret.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 500;
const RESULT_ROWS = 1000;
const HOUR_PRESETS = [[24, "24 h"], [48, "48 h"], [168, "7 days"], [720, "30 days"], [2160, "90 days"]];
const ISSUED_TO_HINT = "For attribution and usage; this person does not get dashboard access.";
const runs = { jwt: null, product: null };

/** The explicit model choice. `values()` returns the ticked models; nothing is ever pre-ticked. */
function modelPicker(kind, options) {
  let mode = "one";
  const list = el("div", { class: "picker-list" });
  const hint = el("p", { class: "field-hint" });
  const summary = el("p", { class: "picker-summary", "aria-live": "polite" });
  const error = el("p", { class: "field-error", id: uid("models-error"), hidden: true });
  const modeSwitch = segmented({ label: "How many models", value: mode, options: [{ value: "one", label: "One model" }, { value: "several", label: "Several models" }],
    onChange: (m) => { mode = m; draw(); } });
  const values = () => [...list.querySelectorAll(".picker-input:checked")].map((i) => i.value);
  const update = () => {
    const v = values();
    summary.textContent = mode === "one"
      ? (v.length ? `Selected: ${v[0]}` : "Nothing selected yet.")
      : `${v.length} ticked${v.length ? `: ${v.join(", ")}` : ""}${v.length < 2 ? ". Tick at least two." : "."}`;
  };
  function draw() {
    hint.textContent = mode === "one" ? "The key may call exactly this model." : "Tick every model the key may call, at least two. None are ticked for you.";
    const name = uid("model");
    setChildren(list, ...["openai", "claude"].map((route) => {
      const opts = options.filter((o) => o.route === route);
      if (!opts.length) return null;
      return el("fieldset", { class: "picker-group" },
        el("legend", { class: "picker-group-title" }, `${ROUTE_LABEL[route]} route`),
        opts.map((o) => el("label", { class: "picker-option" },
          el("input", { type: mode === "one" ? "radio" : "checkbox", class: "picker-input", name, value: o.value }),
          el("span", { class: "picker-text" }, el("span", { class: "mono picker-name" }, o.label), o.detail ? el("span", { class: "picker-detail" }, o.detail) : null),
          routeBadge(o.route))));
    }));
    update();
  }
  list.addEventListener("change", update);
  const wrap = el("fieldset", { class: "picker", "aria-describedby": error.id },
    el("legend", { class: "field-label" }, kind === "jwt" ? "Models (gateway aliases)" : "Models (Foundry deployments)"),
    options.length ? [modeSwitch, hint, list, summary] : emptyState(
      kind === "jwt" ? "No models are pinned." : "No ready deployments were found.",
      kind === "jwt" ? "Pin a Foundry deployment to an alias on the Models page first." : "Deploy a model in the gateway's Foundry account, then reload this page.",
      kind === "jwt" ? el("a", { class: "btn btn-secondary btn-sm", href: "#/models" }, "Open Models") : null),
    kind === "product" && options.length ? el("p", { class: "field-hint" }, "Clients send the deployment name as the request's model field.") : null,
    error);
  if (options.length) draw();
  return {
    wrap,
    get mode() { return mode; },
    get control() { return list.querySelector(".picker-input") ?? wrap; },
    values,
    setError(message) {
      error.textContent = message ?? "";
      error.hidden = !message;
      wrap.classList.toggle("is-invalid", Boolean(message));
    },
    reset() {
      mode = "one";
      const first = modeSwitch.querySelector('input[value="one"]');
      if (first) first.checked = true;
      if (options.length) draw();
    },
  };
}

const input = (attrs) => el("input", { class: "input", autocomplete: "off", spellcheck: "false", ...attrs });
const numberInput = (attrs) => input({ type: "number", inputmode: "numeric", step: "1", ...attrs });

/** The grant settings shared by single and bulk issue, as fields keyed like validateSettings. */
function settingsFields(kind) {
  if (kind === "jwt") {
    const hours = field({ label: "Valid for (hours)", control: numberInput({ min: "1", max: String(LIMITS.hours[1]), value: "48" }) });
    const preset = (h) => () => {
      hours.control.value = String(h);
      hours.control.dispatchEvent(new Event("input", { bubbles: true }));
    };
    addChildren(hours.wrap, el("div", { class: "row row-tight presets", role: "group", "aria-label": "Validity presets" },
      HOUR_PRESETS.map(([h, label]) => el("button", { type: "button", class: "btn btn-ghost btn-xs", onclick: preset(h) }, label))));
    return {
      startInHours: field({ label: "Starts in (hours from now)", control: numberInput({ min: "0", max: String(LIMITS.startInHours[1]), step: "any", inputmode: "decimal", value: "0" }),
        hint: "0 starts it immediately. Decimals are fine: 1.5 is 90 minutes." }),
      hours,
      budget: field({ label: "Token budget", control: numberInput({ min: "1", max: String(LIMITS.budget[1]), value: "100000" }), hint: "Total tokens over the key's life, 1 to 100,000,000." }),
      label: field({ label: "Label", optional: true, control: input({ type: "text", maxlength: String(LIMITS.label) }), hint: "Shown in lists, for example a team or event name." }),
    };
  }
  return {
    monthlyTokens: field({ label: "Monthly token budget", control: numberInput({ min: "1", max: String(LIMITS.monthlyTokens[1]), value: "1000000" }), hint: "Per key, per calendar month." }),
    rotateDays: field({ label: "Rotate automatically every (days)", optional: true, control: numberInput({ min: "1", max: "90" }), hint: "1 to 90. Blank leaves automation off." }),
    expiresDays: field({ label: "Expires after (days)", optional: true, control: numberInput({ min: "1", max: "3650" }), hint: "1 to 3,650. Then it is suspended and archived." }),
  };
}

/** "Active from … until …" under the fields, recomputed as the start or the validity changes. */
function windowPreview(fields) {
  const line = el("p", { class: "window-line span-all", "aria-live": "polite" });
  const update = () => {
    const w = activeWindow(fields.startInHours.control.value, fields.hours.control.value);
    line.textContent = w ? `Active from ${fmtDateTime(w.from)} until ${fmtDateTime(w.until)}.`
      : `Starts 0 to ${fmtInt(LIMITS.startInHours[1])} hours from now and lasts up to ${fmtInt(LIMITS.hours[1])} hours (90 days).`;
  };
  for (const f of [fields.startInHours, fields.hours]) f.control.addEventListener("input", update);
  update();
  return { line, update };
}

const readValues = (fields, picker) => ({
  ...Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.control.value])),
  mode: picker.mode, models: picker.values(),
});

async function loadOptions(ctx, kind, slot) {
  setChildren(slot, loadingState("Loading models…", 3));
  try {
    return modelOptions(kind, await ctx.config());
  } catch (error) {
    setChildren(slot, errorState(error, () => ctx.rerender()));
    return null;
  }
}

const validity = (from, until) => (from ? `Active from ${fmtDateTime(from)} until ${fmtDateTime(until)}.` : until ? `Valid until ${fmtDateTime(until)}.` : "");

export async function renderIssue(root, ctx, kind) {
  const meta = KINDS[kind];
  const slot = el("div", {});
  const titleId = uid("issue");
  addChildren(root, el("section", { class: "card", "aria-labelledby": titleId }, el("h2", { class: "card-title", id: titleId }, `Issue a ${meta.noun}`), slot));
  const options = await loadOptions(ctx, kind, slot);
  if (!options) return;
  const picker = modelPicker(kind, options);
  const fields = {
    owner: field({ label: "Issued to", control: input({ type: "email", placeholder: "alex@contoso.com" }), hint: ISSUED_TO_HINT }),
    [idField(kind)]: kind === "jwt"
      ? field({ label: "Subject", control: input({ type: "text", maxlength: "64" }), hint: "Team or participant id: letters, digits, dots, dashes, underscores." })
      : field({ label: "Key name", control: input({ type: "text", maxlength: "40" }), hint: "2–40 lowercase letters, digits or dashes." }),
    ...settingsFields(kind),
  };
  const preview = kind === "jwt" ? windowPreview(fields) : null;
  const submit = el("button", { type: "submit", class: "btn btn-primary" }, kind === "jwt" ? "Issue key" : "Issue product key");
  const result = el("div", { "aria-live": "polite" });
  const form = el("form", { class: "form-grid", novalidate: true },
    fields.owner.wrap, fields[idField(kind)].wrap, el("div", { class: "span-all" }, picker.wrap),
    Object.entries(fields).filter(([k]) => k !== "owner" && k !== idField(kind)).map(([, f]) => f.wrap),
    preview?.line,
    el("div", { class: "form-actions span-all" }, submit, el("button", { type: "reset", class: "btn btn-ghost" }, "Clear")));
  if (preview) form.addEventListener("focusin", preview.update);
  form.addEventListener("reset", () => {
    setTimeout(() => { picker.reset(); preview?.update(); });
    for (const f of Object.values(fields)) f.setError(null);
    picker.setError(null);
  });
  form.addEventListener("submit", busy(submit, async () => {
    const check = validateIssue(kind, readValues(fields, picker));
    if (!showErrors({ ...fields, models: picker }, check.errors)) return;
    const { owner, models } = check.body;
    const label = check.body.subject ?? check.body.name;
    const { name, product, notBefore, expiresAt } = await issueKey(kind, check.body, { label, models, opener: submit });
    invalidate(`/api/keys?kind=${kind}`);
    const reveal = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("key"), kind === "jwt" ? "Reveal again" : "Reveal key");
    reveal.addEventListener("click", busy(reveal, () => revealKey({ name, label, kind, models, opener: reveal })));
    setChildren(result, el("div", { class: "callout callout-ok" }, icon("check", "icon callout-icon"),
      el("div", {},
        el("p", {}, el("strong", {}, `Issued ${name}`), ` for ${label}, issued to ${owner}. `,
          kind === "jwt" ? validity(notBefore, expiresAt) : `${product ? `Product ${product}. ` : ""}Reveal it to copy the key.`),
        el("div", { class: "row" }, reveal, el("a", { class: "btn btn-ghost btn-sm", href: `#/${meta.route}` }, "Back to the list")))));
    form.reset();
  }));
  setChildren(slot, form, result);
}

// ── Bulk ────────────────────────────────────────────────────────────────────

export async function renderBulk(root, ctx, kind) {
  const meta = KINDS[kind];
  const id = idField(kind);
  const settingsId = uid("bulk-settings");
  const rowsId = uid("bulk-rows");
  const settingsSlot = el("div", {});
  const rowsSlot = el("div", {});
  const runSlot = el("div", {});
  addChildren(root,
    el("section", { class: "card", "aria-labelledby": settingsId }, el("h2", { class: "card-title", id: settingsId }, "1. Settings for every key"), settingsSlot),
    el("section", { class: "card", "aria-labelledby": rowsId }, el("h2", { class: "card-title", id: rowsId }, `2. Who each key is issued to, and its ${kind === "jwt" ? "subject" : "name"}`), rowsSlot),
    runSlot);
  const options = await loadOptions(ctx, kind, settingsSlot);
  if (!options) return;
  const picker = modelPicker(kind, options);
  const fields = settingsFields(kind);
  const preview = kind === "jwt" ? windowPreview(fields) : null;
  const settingsGrid = el("div", { class: "form-grid" }, el("div", { class: "span-all" }, picker.wrap), Object.values(fields).map((f) => f.wrap), preview?.line);
  if (preview) settingsGrid.addEventListener("focusin", preview.update);
  setChildren(settingsSlot, settingsGrid);

  const text = el("textarea", { class: "input mono", rows: "8", spellcheck: "false", placeholder: `owner,${id}\nalex@contoso.com,${kind === "jwt" ? "team-1" : "alex-laptop"}\nsam@contoso.com,${kind === "jwt" ? "team-2" : "sam-ci"}` });
  const csvField = field({ label: "CSV rows", control: text,
    hint: `One key per row: owner (the email it is issued to), then ${id}. A header row is optional; extra columns are ignored. ${ISSUED_TO_HINT}` });
  const file = el("input", { type: "file", accept: ".csv,text/csv,text/plain", class: "sr-only file-input", id: uid("csv-file") });
  const check = el("button", { type: "button", class: "btn btn-secondary" }, "Check rows");
  const rowsPreview = el("div", { "aria-live": "polite" });
  setChildren(rowsSlot, csvField.wrap,
    el("div", { class: "row" }, check, file, el("label", { class: "btn btn-ghost", for: file.id }, icon("upload"), "Upload a CSV file")),
    rowsPreview);

  let checked = null;
  const parse = () => {
    csvField.setError(null);
    try {
      checked = validateEntries(entriesFromCsv(parseCsv(text.value), kind).entries, kind);
    } catch (error) {
      if (!(error instanceof CsvError)) throw error;
      checked = null;
      csvField.setError(error.message);
      setChildren(rowsPreview);
      return;
    }
    renderPreview("all");
  };
  check.addEventListener("click", parse);
  text.addEventListener("input", () => { if (checked) { checked = null; setChildren(rowsPreview, el("p", { class: "field-hint" }, "The rows changed. Check them again.")); } });
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return csvField.setError("That file is larger than 5 MB. Split it into smaller files.");
    text.value = await f.text();
    parse();
  });

  function renderPreview(filter) {
    const ok = checked.filter((e) => !e.errors.length);
    const bad = checked.length - ok.length;
    const list = filter === "problems" ? checked.filter((e) => e.errors.length) : checked;
    const issue = el("button", { type: "button", class: "btn btn-primary", disabled: ok.length === 0 || runs[kind]?.running }, `Issue ${fmtInt(ok.length)} ${ok.length === 1 ? "key" : "keys"}`);
    issue.addEventListener("click", busy(issue, () => start(ok)));
    setChildren(rowsPreview,
      el("div", { class: "preview-head" },
        el("p", {}, el("strong", {}, fmtInt(checked.length)), " rows: ", el("span", { class: "text-ok" }, `${fmtInt(ok.length)} ready`),
          bad ? [" · ", el("span", { class: "text-bad" }, `${fmtInt(bad)} with problems (skipped)`)] : null),
        bad ? segmented({ label: "Show rows", value: filter, cls: "seg-sm", options: [{ value: "all", label: "All" }, { value: "problems", label: "Problems" }], onChange: renderPreview }) : null),
      checked.length ? el("div", { class: "table-wrap table-wrap-tall" }, el("table", { class: "table table-dense" },
        el("caption", { class: "sr-only" }, "Rows to issue"),
        el("thead", {}, el("tr", {}, ["Line", "Issued to", id === "subject" ? "Subject" : "Name", "Check"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, list.slice(0, PREVIEW_ROWS).map((e) => el("tr", { class: e.errors.length ? "row-bad" : null },
          el("td", { class: "num" }, String(e.line)), el("td", {}, e.owner || "—"), el("td", { class: "mono" }, e[id] || "—"),
          el("td", {}, e.errors.length ? el("span", { class: "text-bad" }, e.errors.join(" ")) : el("span", { class: "text-ok" }, "Ready"))))))) : emptyState("No rows found.", "Paste rows above or upload a file."),
      list.length > PREVIEW_ROWS ? el("p", { class: "field-hint" }, `Showing the first ${fmtInt(PREVIEW_ROWS)} of ${fmtInt(list.length)} rows.`) : null,
      el("div", { class: "form-actions" }, issue));
  }

  async function start(entries) {
    const settings = validateSettings(kind, readValues(fields, picker));
    if (!showErrors({ ...fields, models: picker }, settings.errors)) return;
    const b = settings.body;
    const batches = Math.ceil(entries.length / BATCH_SIZE);
    const ok = await confirmDialog({
      title: `Issue ${fmtInt(entries.length)} ${meta.noun}s?`, tone: "primary", confirmLabel: "Issue keys",
      message: `They are sent in ${fmtInt(batches)} ${batches === 1 ? "batch" : "batches"} of up to ${BATCH_SIZE}, one after another. Afterwards you download keys.csv, which holds every key.`,
      points: [`Models: ${b.models.join(", ")}`, kind === "jwt"
        ? `Budget ${fmtInt(b.budget)} tokens. ${b.startInHours ? `Starts ${b.startInHours} hours from now` : "Starts immediately"}, valid ${b.hours} hours.`
        : `${fmtInt(b.monthlyTokens)} tokens a month${b.rotateDays ? `, rotates every ${b.rotateDays} days` : ""}${b.expiresDays ? `, expires after ${b.expiresDays} days` : ""}`],
    });
    if (!ok) return;
    const csv = createBulkCsv(kind);
    const run = { kind, csv, total: entries.length, done: 0, issued: [], failed: [], unsent: [], error: null, running: true, stop: false, onChange: null };
    runs[kind] = run;
    // The rows are spent: clear them so the same rows cannot be issued twice by accident.
    checked = null;
    text.value = "";
    setChildren(rowsPreview, el("p", { class: "field-hint" }, "Rows submitted. Progress and results are below."));
    attach(run);
    await execute(run, b, entries);
  }

  function attach(run) {
    const close = () => {
      run.csv.drop();
      runs[kind] = null;
      setChildren(runSlot);
      text.focus();
    };
    run.onChange = () => setChildren(runSlot, runCard(ctx, run, close));
    run.onChange();
  }
  if (runs[kind]) attach(runs[kind]);
}

async function execute(run, settings, entries) {
  const id = idField(run.kind);
  const notify = () => run.onChange?.();
  run.csv.running = true;
  try {
    for (const batch of chunk(entries, BATCH_SIZE)) {
      if (run.stop || run.csv.dropped) {
        run.unsent.push(...entries.slice(run.done));
        break;
      }
      try {
        const { issued, failed } = await run.csv.issue({ ...settings, entries: batch.map((e) => ({ owner: e.owner, [id]: e[id] })) });
        run.issued.push(...issued);
        for (const f of failed) {
          const e = batch[f.index];
          run.failed.push({ line: e?.line, owner: e?.owner ?? "", [id]: e?.[id] ?? "", error: f.error });
        }
        run.done += batch.length;
      } catch (error) {
        run.error = error;
        run.unsent.push(...entries.slice(run.done));
        reportError(error);
        break;
      }
      notify();
    }
  } finally {
    run.running = false;
    run.csv.running = false;
    invalidate(`/api/keys?kind=${run.kind}`, "/api/usage");
    notify();
  }
}

/** Downloads keys.csv / index.csv, the bundle option, and the issued rows (who and which key, never the key). */
function distribution(ctx, run) {
  const { csv } = run;
  const meta = KINDS[run.kind];
  const dl = (which, label, cls) => {
    const text = el("span", {}, label);
    const button = el("button", { type: "button", class: `btn ${cls}`, disabled: !(which === "keys" ? csv.hasKeys : csv.hasIndex) }, icon("download"), text);
    button.addEventListener("click", busy(button, async () => {
      csv.download(which);
      if (which === "keys") text.textContent = "Download keys.csv again";
      toast(which === "keys" ? "keys.csv downloaded. Send each person only their own row, then delete the file." : "index.csv downloaded.");
    }));
    return button;
  };
  const bundle = el("button", { type: "button", class: "btn btn-secondary" }, "Export as encrypted bundle");
  bundle.addEventListener("click", () => {
    ctx.clearSelection();
    for (const item of run.issued) ctx.select({ kind: run.kind, name: item.name, subject: item.subject, label: item.label }, true);
    ctx.go("#/export");
  });
  return el("div", { class: "distribution" },
    csv.dropped
      ? el("div", { class: "callout callout-warn" }, icon("alert", "icon callout-icon"),
        el("p", {}, "The CSVs were cleared when you left this page. The keys are still valid: export them as an encrypted bundle, or reveal them one by one from the list."))
      : el("div", { class: "callout callout-warn" }, icon("alert", "icon callout-icon"),
        el("p", {}, el("strong", {}, "keys.csv: "), "Contains every key in this batch. Send each person only their own row, then delete the file.")),
    el("div", { class: "form-actions" },
      dl("keys", csv.downloaded ? "Download keys.csv again" : "Download keys.csv", "btn-primary"),
      dl("index", "Download index.csv (no keys — safe to share)", "btn-secondary"),
      bundle),
    el("div", { class: "table-wrap table-wrap-tall" }, el("table", { class: "table table-dense" },
      el("caption", { class: "card-title-sm" }, `Issued ${meta.noun}s (${fmtInt(run.issued.length)})`),
      el("thead", {}, el("tr", {}, (run.kind === "jwt" ? ["Subject", "Issued to", "Key name", "Active from", "Until"] : ["Name", "Issued to", "Key name", "Expires"])
        .map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, run.issued.slice(0, RESULT_ROWS).map((k) => el("tr", {},
        el("td", { class: "mono" }, k.subject ?? k.label ?? "—"), el("td", {}, emailText(k.owner)), el("td", { class: "mono" }, k.name),
        run.kind === "jwt" ? [el("td", { class: "nowrap" }, fmtShortDateTime(k.notBefore)), el("td", { class: "nowrap" }, fmtShortDateTime(k.expiresAt))]
          : el("td", { class: "nowrap" }, k.expiresAt ? fmtShortDateTime(k.expiresAt) : "never")))))),
    run.issued.length > RESULT_ROWS ? el("p", { class: "field-hint" }, `Showing the first ${fmtInt(RESULT_ROWS)} of ${fmtInt(run.issued.length)}; the CSVs hold them all.`) : null);
}

function runCard(ctx, run, close) {
  const id = idField(run.kind);
  const meta = KINDS[run.kind];
  const titleId = uid("run");
  const progress = el("progress", { max: String(run.total), class: "progress", "aria-labelledby": titleId });
  progress.value = run.done;
  const status = run.running
    ? `Issuing… ${fmtInt(run.done)} of ${fmtInt(run.total)} sent (batch ${fmtInt(Math.floor(run.done / BATCH_SIZE) + 1)} of ${fmtInt(Math.ceil(run.total / BATCH_SIZE))}).`
    : `Finished: ${fmtInt(run.issued.length)} issued, ${fmtInt(run.failed.length)} failed${run.unsent.length ? `, ${fmtInt(run.unsent.length)} not sent` : ""}.`;
  const stop = run.running ? el("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: run.stop }, run.stop ? "Stopping after this batch…" : "Stop") : null;
  stop?.addEventListener("click", () => { run.stop = true; stop.disabled = true; stop.textContent = "Stopping after this batch…"; });
  const retryRows = [...run.failed, ...run.unsent];
  const copyRetry = !run.running && retryRows.length ? el("button", { type: "button", class: "btn btn-secondary" }, icon("copy"), `Copy ${fmtInt(retryRows.length)} ${retryRows.length === 1 ? "row" : "rows"} to retry as CSV`) : null;
  copyRetry?.addEventListener("click", busy(copyRetry, async () => {
    await copyText(toCsv([["owner", id], ...retryRows.map((r) => [r.owner, r[id]])]));
    toast("Rows copied. Paste them into the CSV box, fix them, and issue again.");
  }));
  const closeBtn = !run.running ? el("button", { type: "button", class: "btn btn-ghost" }, "Close results") : null;
  closeBtn?.addEventListener("click", busy(closeBtn, async () => {
    if (run.csv.hasKeys && !run.csv.downloaded && !(await confirmDialog({
      title: "Close without downloading keys.csv?", confirmLabel: "Close and discard",
      message: "keys.csv is discarded when the result closes. The keys stay valid and can still be exported as an encrypted bundle.",
    }))) return;
    close();
  }));
  return el("section", { class: "card", "aria-labelledby": titleId },
    el("h2", { class: "card-title", id: titleId }, "3. Progress and results"),
    el("p", { class: "run-status", role: "status" }, status),
    progress,
    run.error ? el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"),
      el("p", {}, `Stopped: ${run.error.message} The batch that failed may be partly issued, so check the ${meta.title.toLowerCase()} list before retrying those rows.`)) : null,
    !run.running && run.issued.length ? distribution(ctx, run) : null,
    run.failed.length ? el("div", { class: "table-wrap table-wrap-tall" }, el("table", { class: "table table-dense" },
      el("caption", { class: "card-title-sm" }, `Failed rows (${fmtInt(run.failed.length)})`),
      el("thead", {}, el("tr", {}, ["Line", "Issued to", id === "subject" ? "Subject" : "Name", "Reason"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, run.failed.map((f) => el("tr", {}, el("td", {}, String(f.line ?? "—")), el("td", {}, f.owner), el("td", { class: "mono" }, f[id]), el("td", { class: "text-bad" }, f.error)))))) : null,
    el("div", { class: "form-actions" }, stop, copyRetry,
      !run.running ? el("a", { class: "btn btn-ghost", href: `#/${meta.route}` }, "Open the list") : null,
      closeBtn));
}

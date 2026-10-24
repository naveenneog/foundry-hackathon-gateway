// Key Dashboard — the chargeback report (P59, ADR-0020): a CSV of measured usage per key and model
// for the period the Overview shows, for both key kinds or one. The server builds the file from
// Key Vault tags and usage rows, so it holds no key value; there are no prices.

import { post } from "./api.js";
import { busy, downloadText, el, icon, segmented, toast, uid } from "./dom.js";
import { fmtInt, periodPhrase, periodQuery } from "./lib.js";

const KINDS = [{ value: "all", label: "Both kinds" }, { value: "jwt", label: "Short-lived" }, { value: "product", label: "Product" }];

/** The card, and `sync()` to call when ctx.period changes. */
export function chargebackCard(ctx) {
  const titleId = uid("card");
  let kind = "all";
  const covers = el("p", { class: "field-hint" });
  const download = el("button", { type: "button", class: "btn btn-primary", "data-help-focus": true }, icon("download"), "Download CSV");
  download.addEventListener("click", busy(download, async () => {
    const r = await post("/api/chargeback", { ...periodQuery(ctx.period), kind });
    downloadText(r.filename, r.csv, "text/csv;charset=utf-8");
    toast(`Chargeback report downloaded: ${fmtInt(r.rows)} ${r.rows === 1 ? "row" : "rows"}, ${fmtInt(r.totals?.tokens ?? 0)} tokens.`);
  }));
  const card = el("section", { class: "card", "aria-labelledby": titleId, "data-help": "chargeback" },
    el("h2", { class: "card-title", id: titleId }, "Chargeback report"),
    el("p", {}, "A CSV with one row per key and model: tokens, requests, first and last use, who the key is issued to, its label and other tags, status and Foundry. Usage of a key no longer in Key Vault is listed as unknown, with its key id."),
    el("div", { class: "row" },
      segmented({ label: "Keys in the report", value: kind, cls: "seg-sm", options: KINDS, onChange: (v) => { kind = v; } }),
      download),
    covers,
    el("p", { class: "field-hint" }, "No prices: Foundry pricing varies by model and deployment, and Claude is billed in CCU. Multiply the token columns by your own rates."));
  const sync = () => { covers.textContent = `Covers ${periodPhrase(ctx.period)}, the period chosen at the top of this page.`; };
  sync();
  return { card, sync };
}

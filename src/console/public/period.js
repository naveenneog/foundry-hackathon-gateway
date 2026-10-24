// Key Dashboard — the usage period: 24 hours, 7, 30 or 90 days, or a custom range of whole UTC days
// (P59). One radio group holds the presets and Custom; Custom shows two labelled date inputs and
// Apply. The server checks a range again; checkRange here only gives early feedback.

import { el, field, segmented, showErrors, uid } from "./dom.js";
import { checkRange, DAY, isoDay, isRange, PERIODS, RANGE_DAYS, rangeLimits, utcDay } from "./lib.js";

/**
 * `value` is a number of days or { from, to }; `onChange` receives the same, once a preset is
 * chosen or a valid range applied. Choosing Custom shows the dates without moving focus, so
 * arrowing through the options stays in the radio group.
 */
export function periodControl(value, onChange, { now = () => Date.now() } = {}) {
  const custom = isRange(value);
  const { min, max } = rangeLimits(now());
  const date = (v) => el("input", { type: "date", class: "input input-date", min, max, value: v, required: true });
  const from = field({ label: "From (UTC)", control: date(custom ? value.from : isoDay(utcDay(max) - 6 * DAY)) });
  const to = field({ label: "To (UTC)", control: date(custom ? value.to : max) });
  const hintId = uid("range-hint");
  for (const f of [from, to]) f.control.setAttribute("aria-describedby", `${f.control.getAttribute("aria-describedby")} ${hintId}`);
  const form = el("form", { class: "period-range", novalidate: true, hidden: !custom, "aria-label": "Custom usage range" },
    from.wrap, to.wrap,
    el("button", { type: "submit", class: "btn btn-secondary btn-sm" }, "Apply"),
    el("p", { class: "field-hint period-hint", id: hintId }, `Whole UTC days, from ${min}: usage is kept for ${RANGE_DAYS} days at no charge.`));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!showErrors({ from, to }, checkRange(from.control.value, to.control.value, now()))) return;
    onChange({ from: from.control.value, to: to.control.value });
  });

  const group = segmented({
    label: "Usage period", value: custom ? "custom" : value, cls: "seg-sm",
    options: [...PERIODS.map((d) => ({ value: d, label: d === 1 ? "24 h" : `${d} d` })), { value: "custom", label: "Custom" }],
    onChange: (v) => {
      mark();
      form.hidden = v !== "custom";
      if (v !== "custom") onChange(v);
    },
  });
  // The guide's Show me focuses the chosen period.
  const mark = () => { for (const r of group.querySelectorAll("input")) r.toggleAttribute("data-help-focus", r.checked); };
  mark();
  return el("div", { class: "period", "data-help": "usage-period" }, group, form);
}

// Key Dashboard — hand-written SVG charts. Colours come from CSS classes and currentColor, so a
// theme switch recolours a chart without re-rendering it. Every chart is role="img" with a title
// and a description, and time series also carry their full data in a visually hidden table.

import { addChildren, el, kpi, setChildren, svgEl, uid } from "./dom.js";
import {
  alignSeries, DAY, describeSeries, fmtBucket, fmtCompact, fmtInt, fmtPercent, KINDS, labelIndices, niceTicks, periodDays, periodPhrase, scaleLinear, topWithOther,
} from "./lib.js";

// One ResizeObserver for every chart. A chart draws at its container's pixel width, so text keeps
// its real size at any width, and redraws only when that width changes.
const drawers = new WeakMap();
const widths = new WeakMap();
let observer = null;

function onWidth(node, draw) {
  drawers.set(node, draw);
  observer ??= new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (!target.isConnected) {
        observer.unobserve(target);
        continue;
      }
      const w = Math.floor(contentRect.width);
      if (w > 0 && w !== widths.get(target)) {
        widths.set(target, w);
        drawers.get(target)?.(w);
      }
    }
  });
  observer.observe(node);
}

export function legend(items) {
  return el("ul", { class: "legend" }, items.map((it) => el("li", {}, el("span", { class: `swatch ${it.cls}`, "aria-hidden": "true" }), it.label)));
}

/** The chart's data as a table for assistive technology. The hidden box is a block: a table would ignore width: 1px and widen the page. */
function dataTable(title, times, step, series) {
  return el("div", { class: "sr-only" }, el("table", {},
    el("caption", {}, `${title}, data`),
    el("thead", {}, el("tr", {},
      el("th", { scope: "col" }, step >= DAY ? "Day (UTC)" : "Hour"),
      series.map((s) => el("th", { scope: "col" }, `${s.name} tokens`)))),
    el("tbody", {}, times.map((t, i) => el("tr", {},
      el("th", { scope: "row" }, fmtBucket(t, step, { long: true })),
      series.map((s) => el("td", {}, fmtInt(s.values[i]))))))));
}

const M = { top: 14, right: 16, bottom: 30, left: 52 };

/**
 * Tokens over time for one or more series ([{ name, cls, values }]) aligned on `times`.
 * One series draws an area; several draw lines. Hover, or focus and use the arrow keys, for values.
 */
export function timeChart({ title, times, step, series, height = 240, emptyText = "No tokens were used in this period." }) {
  const fig = el("figure", { class: "chart" });
  const frame = el("div", { class: "chart-frame" });
  const total = series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
  if (series.length > 1) addChildren(fig, legend(series.map((s) => ({ label: s.name, cls: s.cls }))));
  addChildren(fig, frame);
  if (!times.length || total === 0) {
    frame.classList.add("chart-frame-empty");
    addChildren(frame, el("p", { class: "chart-empty" }, emptyText));
    return fig;
  }
  const desc = describeSeries({ names: series.map((s) => s.name), times, values: series.map((s) => s.values), step });
  const live = el("p", { class: "sr-only", "aria-live": "polite" });
  addChildren(fig, dataTable(title, times, step, series), live);
  const unit = step >= DAY ? "day" : "hour";
  let active = -1;

  function draw(width) {
    const W = Math.max(280, width);
    const H = height;
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;
    const n = times.length;
    const ticks = niceTicks(0, Math.max(...series.flatMap((s) => s.values)), ih < 160 ? 3 : 4, { integer: true });
    const x = (i) => M.left + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = scaleLinear(0, ticks.at(-1), M.top + ih, M.top);
    const titleId = uid("chart-title");
    const descId = uid("chart-desc");
    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0", "aria-labelledby": `${titleId} ${descId}` },
      svgEl("title", { id: titleId }, title),
      svgEl("desc", { id: descId }, `${desc} Use the left and right arrow keys to read each ${unit}.`));

    const grid = svgEl("g", { class: "chart-grid", "aria-hidden": "true" });
    for (const t of ticks) {
      addChildren(grid, svgEl("line", { x1: M.left, x2: W - M.right, y1: y(t).toFixed(1), y2: y(t).toFixed(1), class: t === 0 ? "chart-baseline" : null }),
        svgEl("text", { x: M.left - 8, y: y(t).toFixed(1), dy: "0.32em", "text-anchor": "end", class: "chart-tick" }, fmtCompact(t)));
    }
    for (const i of labelIndices(n, Math.max(2, Math.floor(iw / (step >= DAY ? 68 : 60))))) {
      const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      addChildren(grid, svgEl("text", { x: x(i).toFixed(1), y: H - 10, "text-anchor": anchor, class: "chart-tick" }, fmtBucket(times[i], step)));
    }
    addChildren(svg, grid);

    for (const s of series) {
      const g = svgEl("g", { class: `chart-series ${s.cls}`, "aria-hidden": "true" });
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
      if (series.length === 1 && n > 1) {
        addChildren(g, svgEl("path", { class: "chart-area", d: `${d}L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z` }));
      }
      if (n > 1) addChildren(g, svgEl("path", { class: "chart-line", d }));
      if (n <= 16) s.values.forEach((v, i) => addChildren(g, svgEl("circle", { class: "chart-point", cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 2.5 })));
      addChildren(svg, g);
    }

    const cursor = svgEl("line", { class: "chart-cursor", y1: M.top, y2: M.top + ih, visibility: "hidden" });
    const dots = series.map((s) => svgEl("circle", { class: `chart-dot ${s.cls}`, r: 4.5, visibility: "hidden" }));
    const tip = svgEl("g", { class: "chart-tip", visibility: "hidden", "aria-hidden": "true" });
    addChildren(svg, svgEl("rect", { class: "chart-hit", x: M.left - 8, y: M.top, width: iw + 16, height: ih }), cursor, ...dots, tip);

    const show = (i, announce) => {
      active = i;
      const cx = x(i);
      cursor.setAttribute("x1", cx.toFixed(1));
      cursor.setAttribute("x2", cx.toFixed(1));
      series.forEach((s, k) => {
        dots[k].setAttribute("cx", cx.toFixed(1));
        dots[k].setAttribute("cy", y(s.values[i]).toFixed(1));
      });
      const rows = series.map((s) => [`${s.name}: ${fmtInt(s.values[i])}`, s.cls]);
      if (series.length > 1) rows.push([`Total: ${fmtInt(series.reduce((a, s) => a + s.values[i], 0))}`, null]);
      const head = fmtBucket(times[i], step, { long: true });
      const box = svgEl("rect", { class: "chart-tip-box", rx: 6 });
      setChildren(tip, box);
      const texts = [svgEl("text", { x: 10, y: 20, class: "chart-tip-head" }, head)];
      rows.forEach(([text, cls], k) => {
        const cy = 40 + k * 18;
        if (cls) addChildren(tip, svgEl("circle", { class: `chart-tip-swatch ${cls}`, cx: 14, cy: cy - 4, r: 4 }));
        texts.push(svgEl("text", { x: cls ? 24 : 10, y: cy, class: "chart-tip-row" }, text));
      });
      addChildren(tip, ...texts);
      const bw = Math.ceil(Math.max(...texts.map((t) => t.getComputedTextLength() + Number(t.getAttribute("x"))))) + 12;
      const bh = 30 + rows.length * 18;
      box.setAttribute("width", bw);
      box.setAttribute("height", bh);
      const right = cx + 12;
      const left = right + bw > W - M.right ? Math.max(M.left, cx - 12 - bw) : right;
      tip.setAttribute("transform", `translate(${left.toFixed(1)} ${M.top})`);
      for (const node of [cursor, tip, ...dots]) node.setAttribute("visibility", "visible");
      if (announce) live.textContent = [head, ...rows.map(([text]) => text)].join(". ");
    };
    const hide = () => {
      for (const node of [cursor, tip, ...dots]) node.setAttribute("visibility", "hidden");
    };
    const indexAt = (event) => {
      const ctm = svg.getScreenCTM();
      if (!ctm || n === 1) return 0;
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      return Math.min(n - 1, Math.max(0, Math.round(((p.x - M.left) / iw) * (n - 1))));
    };
    svg.addEventListener("pointermove", (e) => show(indexAt(e), false));
    svg.addEventListener("pointerleave", () => { if (document.activeElement !== svg) hide(); });
    svg.addEventListener("focus", () => show(active >= 0 && active < n ? active : n - 1, true));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return hide();
      const next = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: n - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      show(Math.min(n - 1, Math.max(0, next)), true);
    });
    return svg;
  }

  onWidth(frame, (width) => setChildren(frame, draw(width)));
  return fig;
}

/** Horizontal bars as a readable list: the text carries the data, the SVG bar is decoration. */
export function barList({ label, items, format = fmtCompact, emptyText = "Nothing to show for this period." }) {
  if (!items.length) return el("p", { class: "chart-empty" }, emptyText);
  const top = Math.max(1, ...items.map((it) => it.value));
  return el("ol", { class: "barlist", "aria-label": label }, items.map((it) => {
    const pct = Math.max(0.6, (it.value / top) * 100);
    const name = it.onSelect
      ? el("button", { type: "button", class: "link-btn barlist-name", onclick: it.onSelect }, it.label)
      : el("span", { class: "barlist-name" }, it.label);
    return el("li", { class: "barlist-item" },
      el("div", { class: "barlist-text" },
        el("span", { class: "barlist-label" }, name, it.sub ? el("span", { class: "barlist-sub" }, it.sub) : null),
        el("span", { class: "barlist-value", title: `${fmtInt(it.value)} tokens` }, format(it.value))),
      svgEl("svg", { class: `barlist-bar ${it.cls ?? "s-neutral"}`, viewBox: "0 0 100 6", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
        svgEl("rect", { class: "barlist-track", width: 100, height: 6 }),
        svgEl("rect", { class: "barlist-fill", width: pct.toFixed(2), height: 6 })));
  }));
}

/** A donut of shares ([{ label, value }]) with a legend that states every value and percentage. */
export function donut({ title, items, centerLabel = "tokens", maxSlices = 6 }) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return el("p", { class: "chart-empty" }, "No tokens were used in this period.");
  const slices = topWithOther(items.filter((it) => it.value > 0), maxSlices);
  const R = 54;
  const C = 2 * Math.PI * R;
  const c = 70;
  const gap = slices.length > 1 ? 1.5 : 0;
  const titleId = uid("donut-title");
  const descId = uid("donut-desc");
  const cls = (s, i) => (s.other ? "c-other" : `c${(i % 6) + 1}`);
  const svg = svgEl("svg", { class: "donut", viewBox: "0 0 140 140", role: "img", "aria-labelledby": `${titleId} ${descId}` },
    svgEl("title", { id: titleId }, title),
    svgEl("desc", { id: descId }, `${fmtInt(total)} ${centerLabel}: ${slices.map((s) => `${s.label} ${fmtPercent(s.value / total)}`).join(", ")}.`),
    svgEl("circle", { class: "donut-track", cx: c, cy: c, r: R }));
  let offset = 0;
  slices.forEach((s, i) => {
    const len = (s.value / total) * C;
    const dash = Math.max(0.5, len - gap);
    addChildren(svg, svgEl("circle", {
      class: `donut-seg ${cls(s, i)}`, cx: c, cy: c, r: R, transform: `rotate(-90 ${c} ${c})`,
      "stroke-dasharray": `${dash.toFixed(2)} ${(C - dash).toFixed(2)}`, "stroke-dashoffset": (-offset).toFixed(2),
    }));
    offset += len;
  });
  addChildren(svg, svgEl("text", { class: "donut-total", x: c, y: c + 2, "text-anchor": "middle" }, fmtCompact(total)),
    svgEl("text", { class: "donut-caption", x: c, y: c + 20, "text-anchor": "middle" }, centerLabel));
  return el("div", { class: "donut-wrap" }, svg,
    el("ul", { class: "donut-legend" }, slices.map((s, i) => el("li", {},
      el("span", { class: `swatch ${cls(s, i)}`, "aria-hidden": "true" }),
      el("span", { class: "donut-name" }, s.label),
      el("span", { class: "donut-value", title: `${fmtInt(s.value)} tokens` }, fmtCompact(s.value)),
      el("span", { class: "donut-pct" }, fmtPercent(s.value / total))))));
}

/**
 * One usage response for a kind, or for one key: totals, tokens over time and tokens by model.
 * `period` is a number of days or { from, to }; `title` names the chart for assistive technology.
 */
export function usageBody(kind, data, period, { title = KINDS[kind].title, compact = false } = {}) {
  const total = data?.total ?? {};
  const { times, step, values } = alignSeries([data?.series], { days: periodDays(period), from: data?.from, to: data?.to });
  const unit = step >= DAY ? "day" : "hour";
  const cls = KINDS[kind].cls;
  const n = (v) => Number(v) || 0;
  return el("div", { class: ["usage", compact ? "usage-compact" : ""] },
    el("div", { class: "kpis kpis-compact" },
      kpi({ label: "Tokens", value: fmtCompact(n(total.tokens)), exact: n(total.tokens), cls }),
      kpi({ label: "Requests", value: fmtCompact(n(total.requests)), exact: n(total.requests) }),
      kpi({ label: "Prompt", value: fmtCompact(n(total.prompt)), exact: n(total.prompt) }),
      kpi({ label: "Completion", value: fmtCompact(n(total.completion)), exact: n(total.completion) })),
    el("div", { class: "usage-grid" },
      el("div", { class: "usage-chart" },
        el("h3", { class: "section-title" }, `Tokens per ${unit}`),
        timeChart({ title: `${title}: tokens per ${unit}, ${periodPhrase(period)}`, times, step, height: compact ? 200 : 240, series: [{ name: title, cls, values: values[0] }] }),
        el("p", { class: "field-hint" }, `${unit === "day" ? "Days are UTC days." : "Hours are in your local time."}${data?.note ? "" : " Usage arrives a few minutes after each call."}`)),
      el("div", { class: "usage-models" },
        el("h3", { class: "section-title" }, "By model"),
        barList({ label: `${title}: tokens by model`, items: (data?.byModel ?? []).map((m) => ({ label: String(m.model ?? "unknown"), value: n(m.tokens), cls })).sort((a, b) => b.value - a.value) }))),
    data?.note ? el("p", { class: "note" }, data.note) : null);
}

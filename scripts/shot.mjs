#!/usr/bin/env node
/**
 * shot.mjs - step screenshots for a simple README.
 *
 * Opens each page, does the clicks, hides every secret, draws a numbered badge
 * and a ring around the thing the reader must click, and saves a PNG per step.
 *
 * Setup (once, in the project you are documenting):
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Use:
 *   node scripts/shot.mjs --steps scripts/steps.json --out docs/img
 *   node scripts/shot.mjs --only 3                  # redo one step
 *   node scripts/shot.mjs --headed --slowmo 300     # watch it work
 *   node scripts/shot.mjs --channel msedge          # portals with device policy
 *   node scripts/shot.mjs --save-auth auth.json     # sign in by hand, save session
 *   node scripts/shot.mjs --auth auth.json          # reuse that session
 *
 * Masking is done twice on purpose: an overlay box in the page, and Playwright's
 * own screenshot mask. A caption is printed under each box so the reader knows
 * something was hidden, not broken.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir, platform } from 'node:os';

// ------------------------------------------------------------------ args ---

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stepsPath = args.steps || 'scripts/steps.json';
const outDir = args.out || 'docs/img';

function die(msg, code = 1) {
  console.error(`\n  ${msg}\n`);
  process.exit(code);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  die('Playwright is not installed here.\n' +
      '  Run:  npm i -D playwright  &&  npx playwright install chromium');
}

// Playwright's bundled browser for THIS version may be missing (or a half-finished
// download) while a perfectly good chromium from another version sits in the same
// cache. Rather than force a re-download, find any complete binary and use it.
function findInstalledChromium() {
  const roots = {
    win32: path.join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    darwin: path.join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    linux: path.join(homedir(), '.cache', 'ms-playwright'),
  };
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || roots[platform()];
  if (!root || !fs.existsSync(root)) return null;

  const candidates = [];
  for (const dir of fs.readdirSync(root)) {
    const version = Number(dir.split('-').pop());
    for (const rel of [
      ['chrome-win', 'chrome.exe'],
      ['chrome-win64', 'chrome.exe'],
      ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ['chrome-linux', 'chrome'],
      ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ]) {
      const exe = path.join(root, dir, ...rel);
      // Prefer full chromium over headless-shell: it can also run headed.
      if (fs.existsSync(exe)) candidates.push({ exe, version, shell: dir.includes('headless_shell') });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.shell - b.shell || b.version - a.version);
  return candidates[0].exe;
}

async function launch(opts) {
  try {
    return await chromium.launch(opts);
  } catch (err) {
    const exe = findInstalledChromium();
    if (!exe) {
      die(`No usable Chromium found.\n  ${err.message.split('\n')[0]}\n` +
          '  Fix: npx playwright install chromium');
    }
    console.log(`  note: bundled browser missing, using ${exe}`);
    return chromium.launch({ ...opts, executablePath: exe });
  }
}

// --------------------------------------------------------- save-auth mode ---

const launchOpts = { headless: !(args.headed || args['save-auth']) };
if (args.channel) launchOpts.channel = args.channel;
if (args.slowmo) launchOpts.slowMo = Number(args.slowmo);

if (args['save-auth']) {
  const target = String(args['save-auth']);
  const startUrl = args.url || args.base || 'about:blank';
  const browser = await launch({ ...launchOpts, headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(startUrl);
  console.log('\n  A browser window is open.');
  console.log('  1. Sign in by hand.');
  console.log('  2. Come back here and press Enter.\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await ctx.storageState({ path: target });
  await browser.close();
  console.log(`  Saved the signed-in session to ${target}`);
  console.log('  Never commit that file - it holds your login.\n');
  process.exit(0);
}

// ----------------------------------------------------------------- input ---

if (!fs.existsSync(stepsPath)) {
  die(`Cannot find ${stepsPath}.\n` +
      '  Copy templates/steps.json into your project and fill it in.');
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
} catch (e) {
  die(`${stepsPath} is not valid JSON.\n  ${e.message}`);
}

const baseUrl = args.base || cfg.baseUrl || '';
const steps = (cfg.steps || []).filter((s) => {
  if (args.only === undefined || args.only === true) return true;
  return String(s.id) === String(args.only);
});
if (steps.length === 0) die('No steps to shoot. Check --only or the steps array.');

fs.mkdirSync(outDir, { recursive: true });

const maskColor = cfg.maskColor || '#111827';
const globalMaskText = cfg.maskText || [];

function slug(text) {
  return String(text || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function resolveUrl(u) {
  if (!u) return null;
  if (/^[a-z]+:/i.test(u)) return u;
  if (baseUrl) return baseUrl.replace(/\/$/, '') + (u.startsWith('/') ? u : `/${u}`);
  // No baseUrl: treat it as a file next to the steps manifest.
  const [file, hash] = u.split('#');
  const abs = path.resolve(path.dirname(stepsPath), file);
  return `file:///${abs.replace(/\\/g, '/')}${hash ? `#${hash}` : ''}`;
}

// -------------------------------------------------- in-page overlay logic ---

/** Runs inside the page: hides text, paints mask boxes, draws badge + ring. */
function drawOverlay({ maskSelectors, maskPatterns, highlight, badge, color, labels }) {
  const OVERLAY_ID = '__simple_readme_overlay__';
  document.getElementById(OVERLAY_ID)?.remove();

  // 1. Replace secret-looking text with a same-shape mask.
  const mask = (s) => {
    if (s.length <= 6) return '\u2022'.repeat(s.length);
    const head = s.slice(0, 3);
    return head + '\u2022'.repeat(Math.min(14, s.length - 3));
  };
  const regexes = (maskPatterns || []).map((p) => new RegExp(p, 'g'));
  if (regexes.length) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      let t = n.nodeValue;
      if (!t || !t.trim()) continue;
      for (const re of regexes) { re.lastIndex = 0; t = t.replace(re, mask); }
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      let v = el.value;
      if (!v) continue;
      for (const re of regexes) { re.lastIndex = 0; v = v.replace(re, mask); }
      if (v !== el.value) el.value = v;
    }
  }

  // 2. Overlay layer.
  const layer = document.createElement('div');
  layer.id = OVERLAY_ID;
  layer.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'font:600 13px/1.3 -apple-system,Segoe UI,system-ui,sans-serif;';
  document.body.appendChild(layer);

  const box = (r, css) => {
    const d = document.createElement('div');
    d.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;${css}`;
    layer.appendChild(d);
    return d;
  };

  const rects = [];

  // 3. Mask boxes + a caption so the reader knows it is hidden on purpose.
  (maskSelectors || []).forEach((sel, i) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      rects.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      box(r, `background:${color};border-radius:4px;`);

      const label = (labels && labels[i]) || 'hidden';
      const cap = document.createElement('div');
      cap.textContent = label;
      // Right of the box reads best and never covers the next row. Fall back to
      // below, then above, so a caption never lands on top of real content.
      const capW = label.length * 6.2 + 14;
      const fitsRight = r.right + 8 + capW < window.innerWidth;
      const fitsBelow = r.bottom + 20 < window.innerHeight;
      let left = r.left;
      let top = r.bottom + 3;
      if (fitsRight) {
        left = r.right + 8;
        top = r.top + Math.max(0, (r.height - 16) / 2);
      } else if (!fitsBelow) {
        top = Math.max(0, r.top - 19);
      }
      cap.style.cssText =
        `position:fixed;left:${left}px;top:${top}px;` +
        `background:${color};color:#fff;padding:1px 6px;border-radius:3px;` +
        'font-size:11px;font-weight:500;letter-spacing:.02em;opacity:.9;white-space:nowrap;';
      layer.appendChild(cap);
    }
  });

  // 4. Ring + numbered badge on the thing to click.
  if (highlight) {
    const el = document.querySelector(highlight);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const pad = 6;
      box({ left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 },
          'border:3px solid #e11d48;border-radius:8px;' +
          'box-shadow:0 0 0 4px rgba(225,29,72,.20);');
      if (badge) {
        const b = document.createElement('div');
        b.textContent = String(badge);
        b.style.cssText =
          `position:fixed;left:${Math.max(2, r.left - pad - 14)}px;` +
          `top:${Math.max(2, r.top - pad - 14)}px;` +
          'width:28px;height:28px;border-radius:50%;background:#e11d48;color:#fff;' +
          'display:flex;align-items:center;justify-content:center;font-size:15px;' +
          'box-shadow:0 2px 6px rgba(0,0,0,.35);';
        layer.appendChild(b);
      }
    }
  }
  return rects;
}

// ------------------------------------------------------------------- run ---

const browser = await launch(launchOpts);
const ctxOpts = {
  viewport: cfg.viewport || { width: 1280, height: 800 },
  deviceScaleFactor: Number(cfg.deviceScaleFactor || 2),
  colorScheme: cfg.theme === 'dark' ? 'dark' : 'light',
  reducedMotion: 'reduce',
};
if (args.auth) ctxOpts.storageState = String(args.auth);
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();

const written = [];
let failed = 0;

for (const step of steps) {
  const id = step.id ?? steps.indexOf(step) + 1;
  const name = `step-${String(id).padStart(2, '0')}-${slug(step.title)}.png`;
  const file = path.join(outDir, name);
  try {
    const url = resolveUrl(step.url);
    if (url) await page.goto(url, { waitUntil: step.waitUntil || 'networkidle' });

    for (const act of step.actions || []) {
      switch (act.type) {
        case 'click':    await page.click(act.selector, { timeout: 15000 }); break;
        case 'fill':     await page.fill(act.selector, act.value ?? ''); break;
        case 'press':    await page.press(act.selector, act.key || 'Enter'); break;
        case 'hover':    await page.hover(act.selector); break;
        case 'check':    await page.check(act.selector); break;
        case 'select':   await page.selectOption(act.selector, act.value); break;
        case 'goto':     await page.goto(resolveUrl(act.url), { waitUntil: 'networkidle' }); break;
        case 'scrollTo': await page.locator(act.selector).scrollIntoViewIfNeeded(); break;
        case 'waitFor':  await page.waitForSelector(act.selector, { state: act.state || 'visible', timeout: 20000 }); break;
        case 'wait':     await page.waitForTimeout(Number(act.ms || 500)); break;
        case 'eval':     await page.evaluate(act.script); break;
        default: console.warn(`  ! step ${id}: unknown action "${act.type}" - skipped`);
      }
    }

    if (step.waitFor) await page.waitForSelector(step.waitFor, { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(Number(step.settleMs ?? 400));

    const maskSelectors = step.mask || [];
    await page.evaluate(drawOverlay, {
      maskSelectors,
      maskPatterns: [...globalMaskText, ...(step.maskText || [])],
      highlight: step.highlight || null,
      badge: step.badge ?? id,
      color: maskColor,
      labels: step.maskLabels || [],
    });
    await page.waitForTimeout(120);

    const shotOpts = {
      path: file,
      animations: 'disabled',
      caret: 'hide',
      fullPage: !!step.fullPage,
      mask: maskSelectors.map((s) => page.locator(s)),
      maskColor,
    };
    if (step.clip && !step.fullPage) {
      const bb = await page.locator(step.clip).first().boundingBox();
      if (bb) {
        const pad = Number(step.clipPad ?? 12);
        shotOpts.clip = {
          x: Math.max(0, bb.x - pad),
          y: Math.max(0, bb.y - pad),
          width: bb.width + pad * 2,
          height: bb.height + pad * 2,
        };
      }
    }
    await page.screenshot(shotOpts);

    written.push({ id, name, title: step.title || `step ${id}` });
    console.log(`  ok    step ${String(id).padStart(2, '0')}  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  step ${String(id).padStart(2, '0')}  ${e.message.split('\n')[0]}`);
  }
}

await browser.close();

// Paste-ready markdown, so nobody hand-types image paths.
if (written.length) {
  const md = written
    .map((w) => `![Step ${w.id} - ${w.title}](${path.posix.join(outDir.replace(/\\/g, '/'), w.name)})`)
    .join('\n\n');
  const indexFile = path.join(outDir, '_paste-into-readme.md');
  fs.writeFileSync(indexFile, `${md}\n`, 'utf8');
  console.log(`\n  ${written.length} image(s) in ${outDir}`);
  console.log(`  Markdown to paste: ${indexFile}`);
  console.log('  Now open every PNG and check nothing private is still readable.\n');
}

process.exit(failed > 0 ? 1 : 0);

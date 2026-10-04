// Render captured terminal output to PNG, so the README shows real output rather than a mockup.
// Every input here is a verbatim capture from a live run against the deployed gateway.

const fs = require("fs");
const path = require("path");

// Playwright is a devDependency of this repo, but these images are regenerated rarely and the
// install is large. Resolve it from here first, then from a sibling checkout, so a machine that
// already has it does not need a second copy. An absolute path with no fallback used to live
// here, which made this script work on exactly one machine.
function loadChromium() {
  const candidates = [
    "playwright",
    path.join(__dirname, "..", "node_modules", "playwright"),
    "C:/Users/navg/DailyApps/work/CLAUDE/node_modules/playwright",
  ];
  for (const c of candidates) {
    try {
      return require(c).chromium;
    } catch {
      /* try the next one */
    }
  }
  console.error(
    "\n  Playwright not found. Install it here:\n" +
      "    npm i -D playwright && npx playwright install chromium\n"
  );
  process.exit(1);
}

const { chromium } = { chromium: loadChromium() };

const CAPTURE = path.join(__dirname, "..", ".capture");
const OUT = path.join(__dirname, "..", "docs", "images");
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Minimal, deliberate colouring: only the things a reader should scan for.
function colourise(line) {
  let h = esc(line);
  h = h.replace(/\[PASS\]/g, '<span class="pass">[PASS]</span>');
  h = h.replace(/\[FAIL\]/g, '<span class="fail">[FAIL]</span>');
  h = h.replace(/\[ok\]/g, '<span class="pass">[ok]</span>');
  h = h.replace(/-&gt;\s(200|True)\b/g, '-&gt; <span class="ok2">$1</span>');
  h = h.replace(/-&gt;\s(401|403|429|400)\b/g, '-&gt; <span class="code">$1</span>');
  h = h.replace(/(\d+ passed), (0 failed)/g, '<span class="pass">$1</span>, <span class="dim">$2</span>');
  h = h.replace(/(https:\/\/[^\s]+)/g, '<span class="url">$1</span>');
  h = h.replace(/^(\s*)(←|→)\s(.*)$/gm, '$1<span class="tool">$2 $3</span>');
  h = h.replace(/^&gt; build · flash$/gm, '<span class="prompt">&gt; build · flash</span>');
  h = h.replace(/^(\s*\d+)\s\s(.*)$/gm, '<span class="num">$1</span>  $2');
  h = h.replace(/^PS&gt;(.*)$/gm, '<span class="ps">PS&gt;</span><span class="cmd">$1</span>');
  return h;
}

function html(title, subtitle, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin:0; padding:34px; background:#0d1117;
         font-family:"Cascadia Code","Consolas",ui-monospace,monospace; }
  .win { background:#161b22; border:1px solid #30363d; border-radius:10px; overflow:hidden;
         box-shadow:0 16px 48px rgba(0,0,0,.55); }
  .bar { background:#21262d; padding:11px 16px; display:flex; align-items:center; gap:9px;
         border-bottom:1px solid #30363d; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title { color:#8b949e; font-size:12.5px; margin-left:12px; letter-spacing:.2px; }
  .sub { color:#484f58; font-size:11.5px; margin-left:auto; }
  pre { margin:0; padding:22px 26px; color:#c9d1d9; font-size:13.5px; line-height:1.62;
        white-space:pre; }
  .pass{color:#3fb950;font-weight:600} .fail{color:#f85149;font-weight:600}
  .ok2{color:#3fb950} .code{color:#d29922}
  .url{color:#58a6ff} .dim{color:#6e7681}
  .tool{color:#bc8cff} .prompt{color:#58a6ff;font-weight:600} .num{color:#d29922}
  .ps{color:#3fb950;font-weight:600} .cmd{color:#e6edf3}
  </style></head><body>
  <div class="win">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">${esc(title)}</span><span class="sub">${esc(subtitle)}</span></div>
    <pre>${body}</pre>
  </div></body></html>`;
}

const shots = [
  {
    file: "governance-checks.png",
    title: "PowerShell — ./admin.ps1 → 11  (Verify the controls)",
    subtitle: "live gateway",
    src: "governance.txt",
    trim: (t) => t.split(/\r?\n/).filter((l) => l.trim() !== "" || true).join("\n").trim(),
  },
  {
    file: "admin-menu.png",
    title: "PowerShell — ./admin.ps1",
    subtitle: "admin console",
    src: "menu.txt",
    trim: (t) => t.replace(/\n0\s*$/, "").trim(),
  },
  {
    file: "opencode-session.png",
    title: "PowerShell — opencode run --model hackathon-gateway/flash",
    subtitle: "agent session through the gateway",
    src: "opencode.txt",
    trim: (t) => t.trim(),
  },
  {
    file: "models-both-routes.png",
    title: "PowerShell — ./admin.ps1 → 2  (Show models)",
    subtitle: "every Foundry account in the subscription",
    src: "models.txt",
    trim: (t) => t.trim(),
  },
  {
    file: "key-claude.png",
    title: "PowerShell — ./admin.ps1 → 5  (Issue a participant key)",
    subtitle: "the key itself is masked in this screenshot",
    src: "key.txt",
    trim: (t) => t.trim(),
  },
  {
    file: "verify-claude-route.png",
    title: "PowerShell — ./admin.ps1 → 11  (Verify the controls, Claude route)",
    subtitle: "24 checks against the live gateway",
    src: "verify-claude.txt",
    trim: (t) => t.trim(),
  },
  {
    file: "claude-code-session.png",
    title: "PowerShell — claude",
    subtitle: "Claude Code through the gateway, on a participant key",
    src: "claude-code.txt",
    trim: (t) => t.trim(),
  },
  {
    file: "notebook-agent.png",
    title: "examples/claude-agent.ipynb",
    subtitle: "tool-calling agent on a Claude model in Foundry",
    src: "notebook.txt",
    trim: (t) => t.trim(),
  },
];

(async () => {
  // Launch the bundled Chromium if its exact build is present, otherwise drive the Edge that
  // ships with Windows. Rendering styled text needs a browser, not a specific browser, and a
  // 130MB download to regenerate a screenshot is a poor trade.
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.log("bundled chromium unavailable, falling back to the msedge channel");
    browser = await chromium.launch({ channel: "msedge" });
  }
  // Narrow viewport so the terminal window hugs its content instead of floating in
  // a sea of background.
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1080, height: 800 } });

  for (const s of shots) {
    const srcPath = path.join(CAPTURE, s.src);
    if (!fs.existsSync(srcPath)) {
      // Captures are gitignored, so a fresh clone has none. Render what is there rather than
      // failing on the first missing one.
      console.log("skip ", s.file, `(no .capture/${s.src})`);
      continue;
    }
    const raw = fs.readFileSync(srcPath, "utf8");
    const body = colourise(s.trim(raw));
    await page.setContent(html(s.title, s.subtitle, body));
    const el = await page.$(".win");
    await el.screenshot({ path: path.join(OUT, s.file) });
    console.log("wrote", s.file);
  }

  await browser.close();
})();

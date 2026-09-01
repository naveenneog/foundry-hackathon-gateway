#!/usr/bin/env node
/**
 * lint_readme.mjs - does this README actually work for a beginner?
 *
 * It checks the shape (every step has one action, a success signal and a picture)
 * and the language (short sentences, no jargon, no "simply").
 *
 * Use:
 *   node scripts/lint_readme.mjs README.md
 *   node scripts/lint_readme.mjs README.md --strict   # warnings fail too
 *   node scripts/lint_readme.mjs README.md --json     # for CI
 *
 * Exit code: 0 good, 1 needs work, 2 bad usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');

if (!file) {
  console.log('\n  node scripts/lint_readme.mjs README.md [--strict] [--json]\n');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`\n  Cannot find ${file}\n`);
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split(/\r?\n/);
const docDir = path.dirname(path.resolve(file));

const problems = [];
const add = (level, line, rule, message, hint) =>
  problems.push({ level, line, rule, message, hint });

// --------------------------------------------------------------- vocabulary ---

const BANNED = {
  simply: 'Delete it. If it were simple they would not be reading.',
  just: 'Delete it. It makes a stuck reader feel stupid.',
  easy: 'Say how long it takes instead.',
  easily: 'Delete it.',
  obviously: 'Nothing is obvious on day one.',
  trivial: 'Say what to do instead.',
  straightforward: 'Say what to do instead.',
  effortless: 'Delete it.',
  seamless: 'Say what actually happens.',
  powerful: 'Marketing word. Say what it does.',
  robust: 'Marketing word. Say what it does.',
  leverage: 'Say "use".',
  utilize: 'Say "use".',
  facilitate: 'Say "help" or "let".',
  basically: 'Delete it.',
  merely: 'Delete it.',
  aforementioned: 'Say "the ... above".',
  'as you know': 'They do not know.',
  'of course': 'Delete it.',
  'needless to say': 'Then do not say it.',
  'it should be noted': 'Just note it.',
  'in order to': 'Say "to".',
  'at this point in time': 'Say "now".',
  'a while': 'Give a number: "about 2 minutes".',
  'some time': 'Give a number.',
  'a few moments': 'Give a number.',
  shortly: 'Give a number.',
};

const LAZY_ALT = /^(image|images|screenshot|screen shot|picture|pic|img|photo|diagram|step \d+|here|this)\.?$/i;

const SECTIONS = [
  { key: 'expect',   level: 'error', re: /what to expect|before you begin|what this does/i,
    say: 'Add a "What to expect" section: time, cost, what changes on their machine.' },
  { key: 'prereq',   level: 'error', re: /before you start|prerequisite|what you need|you will need/i,
    say: 'Add a "Before you start" section listing what they must already have.' },
  { key: 'preflight',level: 'warn',  re: /check your machine|preflight|ready to start/i,
    say: 'Add a "Check your machine is ready" section with one command to run.' },
  { key: 'verify',   level: 'error', re: /check it worked|verify|did it work|confirm it works/i,
    say: 'Add a "Check it worked" section with one command and its expected output.' },
  { key: 'problems', level: 'error', re: /common problems|troubleshoot|if something (?:goes|went) wrong|when it does not work/i,
    say: 'Add a "Common problems" section: symptom, cause, fix.' },
];

// ------------------------------------------------------------------ parsing ---

const isFence = (l) => /^\s*(?:```|~~~)/.test(l);
const inCode = new Array(lines.length).fill(false);
{
  let open = false;
  lines.forEach((l, i) => {
    if (isFence(l)) { inCode[i] = true; open = !open; return; }
    inCode[i] = open;
  });
  if (open) add('error', lines.length, 'code-fence', 'A code block is never closed.',
                'Add the missing ``` line.');
}

const headings = [];
lines.forEach((l, i) => {
  const m = l.match(/^(#{1,6})\s+(.*)$/);
  if (m && !inCode[i]) headings.push({ line: i + 1, depth: m[1].length, text: m[2].trim() });
});

if (!headings.some((h) => h.depth === 1)) {
  add('error', 1, 'title', 'There is no title line.', 'Start with "# <Project> - Setup guide".');
}

for (const s of SECTIONS) {
  if (!headings.some((h) => s.re.test(h.text))) {
    add(s.level, 1, `section-${s.key}`, `Missing section: ${s.key}.`, s.say);
  }
}

// Steps: "### Step 3 - Create the API key"
const stepHeads = headings
  .map((h) => ({ ...h, m: h.text.match(/^step\s+(\d+)\b\s*[-:\u2013\u2014]?\s*(.*)$/i) }))
  .filter((h) => h.m)
  .map((h) => ({ line: h.line, num: Number(h.m[1]), title: h.m[2], depth: h.depth }));

if (stepHeads.length === 0) {
  add('error', 1, 'steps', 'There are no steps.',
      'Use headings like "### Step 1 - Clone the project".');
}

stepHeads.forEach((s, i) => {
  if (s.num !== i + 1) {
    add('error', s.line, 'step-order',
        `Step ${s.num} comes after ${i} step(s).`, 'Number the steps 1, 2, 3 with no gaps.');
  }
  if (/\band\b/i.test(s.title)) {
    add('warn', s.line, 'step-two-actions',
        `Step ${s.num} title has "and" in it: "${s.title}".`,
        'One action per step. Split it into two steps.');
  }
  if (s.title.length === 0) {
    add('error', s.line, 'step-title', `Step ${s.num} has no title.`,
        'Say what the reader does: "### Step 2 - Install the tools".');
  }
});

// Body of each step = lines until the next heading of the same or higher level.
const stepBlocks = stepHeads.map((s, i) => {
  const start = s.line;
  const next = headings.find((h) => h.line > s.line && h.depth <= s.depth);
  return { ...s, start, end: next ? next.line - 1 : lines.length };
});

for (const b of stepBlocks) {
  const body = lines.slice(b.start, b.end).join('\n');
  if (!/\*\*Do this\*\*/i.test(body)) {
    add('error', b.line, 'step-do',
        `Step ${b.num} has no "**Do this**" block.`, 'Say exactly what to click or run.');
  }
  if (!/\*\*What you should see\*\*/i.test(body)) {
    add('error', b.line, 'step-expect',
        `Step ${b.num} never says what should happen.`,
        'Add "**What you should see**" with the real message or screen.');
  }
  if (!/!\[[^\]]*\]\([^)]+\)/.test(body)) {
    add('error', b.line, 'step-image',
        `Step ${b.num} has no screenshot.`,
        'Add one picture of the thing being clicked, inside the step.');
  }
}

// ------------------------------------------------------------------- images ---

lines.forEach((l, i) => {
  if (inCode[i]) return;
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(l)) !== null) {
    const [, alt, src] = m;
    if (!alt.trim()) {
      add('error', i + 1, 'alt-empty', 'A picture has no alt text.',
          'Describe what to look at: "Step 3 - the Create key button, top right".');
    } else if (LAZY_ALT.test(alt.trim())) {
      add('warn', i + 1, 'alt-lazy', `Alt text "${alt}" says nothing.`,
          'Describe what the reader should look at in the picture.');
    }
    if (!/^https?:/i.test(src)) {
      const target = path.resolve(docDir, decodeURIComponent(src));
      if (!fs.existsSync(target)) {
        add('error', i + 1, 'image-missing', `The picture ${src} is not there.`,
            'Run shot.mjs or mask.py, or fix the path.');
      }
    }
  }
});

// -------------------------------------------------------------- code blocks ---

lines.forEach((l, i) => {
  if (!inCode[i] || isFence(l)) return;
  if (/^\s*(?:\$|PS[ >]|C:\\[^>]*>|#)\s+\S/.test(l) && !/^\s*#\s*(?:!|\s)/.test(l)) {
    add('warn', i + 1, 'shell-prompt', 'This command starts with a prompt symbol.',
        'Remove the $ or PS> so the reader can copy the whole line.');
  }
});

// ------------------------------------------------------------------- prose ---

const proseLines = [];
lines.forEach((l, i) => {
  if (inCode[i] || isFence(l)) return;
  if (/^\s*\|/.test(l)) return;                       // table row
  if (/^\s*!\[/.test(l)) return;                      // image
  if (/^\s*(?:\[[^\]]+\]:|<)/.test(l)) return;        // link ref / html
  const text = l
    .replace(/`[^`]*`/g, ' ')                         // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*[#>*\-+]+\s*/, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/[*_]{1,2}/g, '');
  if (text.trim()) proseLines.push({ n: i + 1, text: text.trim() });
});

for (const { n, text } of proseLines) {
  const lower = ` ${text.toLowerCase()} `;
  for (const [word, hint] of Object.entries(BANNED)) {
    const re = new RegExp(`(?<![\\w-])${word.replace(/ /g, '\\s+')}(?![\\w-])`, 'i');
    if (re.test(lower)) add('warn', n, 'banned-word', `"${word}" - ${hint}`, null);
  }
  if (/\b(?:TODO|TBD|FIXME|XXX|lorem ipsum)\b/i.test(text)) {
    add('error', n, 'unfinished', 'This line is unfinished.', 'Finish it or delete it.');
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    if (words.length > 20) {
      add('warn', n, 'long-sentence', `${words.length} words in one sentence.`,
          'Keep sentences under 20 words. Split it in two.');
    }
  }
}

// Flesch-Kincaid grade, prose only.
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const t = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return (t.match(/[aeiouy]{1,2}/g) || ['x']).length;
}

const allProse = proseLines.map((p) => p.text).join(' ');
const sentences = allProse.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().split(/\s+/).length > 2);
const words = allProse.split(/\s+/).filter((w) => /[a-z]/i.test(w));
const syllableCount = words.reduce((sum, w) => sum + syllables(w), 0);
let grade = 0;
if (sentences.length && words.length) {
  grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllableCount / words.length) - 15.59;
  grade = Math.round(grade * 10) / 10;
  if (grade > 9) {
    add('warn', 1, 'reading-level',
        `Reading level is grade ${grade}. Aim for 8 or lower.`,
        'Shorter sentences. Everyday words. One idea per sentence.');
  }
}

// ------------------------------------------------------------------ report ---

const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');
const stats = {
  steps: stepHeads.length,
  images: (raw.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length,
  words: words.length,
  readingGrade: grade,
  minutesToRead: Math.max(1, Math.round(words.length / 200)),
};

if (asJson) {
  console.log(JSON.stringify({
    file, ok: errors.length === 0 && (!strict || warns.length === 0),
    errors: errors.length, warnings: warns.length, stats, problems,
  }, null, 2));
} else {
  console.log('');
  for (const p of [...problems].sort((a, b) => a.line - b.line)) {
    const tag = p.level === 'error' ? 'ERROR' : 'warn ';
    console.log(`  ${tag}  ${file}:${p.line}  [${p.rule}]  ${p.message}`);
    if (p.hint) console.log(`         -> ${p.hint}`);
  }
  if (problems.length) console.log('');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  console.log(`  ${plural(stats.steps, 'step', 'steps')}, ${plural(stats.images, 'picture', 'pictures')}, ` +
              `${stats.words} words, grade ${stats.readingGrade}, about ${stats.minutesToRead} min to read.`);
  console.log(`  ${plural(errors.length, 'error', 'errors')}, ${plural(warns.length, 'warning', 'warnings')}.`);
  console.log(errors.length === 0
    ? '  Good. Now hand it to someone who has never seen the project.\n'
    : '  Fix every ERROR above. Do not lower the bar in this script.\n');
}

process.exit(errors.length > 0 || (strict && warns.length > 0) ? 1 : 0);

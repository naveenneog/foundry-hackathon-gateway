#!/usr/bin/env node
/**
 * scrub.mjs - find secrets that leaked into a document.
 *
 * Screenshots are masked with shot.mjs / mask.py. This catches the other half:
 * the key someone pasted into a code block, the tenant id in an example command,
 * the personal email in a git config line.
 *
 * Use:
 *   node scripts/scrub.mjs README.md
 *   node scripts/scrub.mjs README.md scripts/steps.json docs/*.md
 *   node scripts/scrub.mjs README.md --env .env      # also hunt for YOUR real values
 *   node scripts/scrub.mjs README.md --fix           # rewrite hits as placeholders
 *   node scripts/scrub.mjs README.md --json          # for CI
 *   node scripts/scrub.mjs README.md --strict        # warnings fail too
 *
 * Exit code: 0 clean, 1 something found, 2 bad usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ----------------------------------------------------------------- rules ---
// level: 'error' = almost certainly a real secret. 'warn' = often fine, look at it.

const RULES = [
  { id: 'private-key', level: 'error', placeholder: '<YOUR_PRIVATE_KEY>',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    say: 'A private key block is in the document.' },
  { id: 'jwt', level: 'error', placeholder: '<YOUR_TOKEN>',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    say: 'This looks like a signed token (JWT).' },
  { id: 'openai-key', level: 'error', placeholder: '<YOUR_API_KEY>',
    re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
    say: 'This looks like an API key.' },
  { id: 'github-token', level: 'error', placeholder: '<YOUR_GITHUB_TOKEN>',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    say: 'This is a GitHub token.' },
  { id: 'aws-key', level: 'error', placeholder: '<YOUR_AWS_ACCESS_KEY_ID>',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    say: 'This is an AWS access key id.' },
  { id: 'google-key', level: 'error', placeholder: '<YOUR_GOOGLE_API_KEY>',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    say: 'This is a Google API key.' },
  { id: 'slack-token', level: 'error', placeholder: '<YOUR_SLACK_TOKEN>',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    say: 'This is a Slack token.' },
  { id: 'npm-token', level: 'error', placeholder: '<YOUR_NPM_TOKEN>',
    re: /\bnpm_[A-Za-z0-9]{30,}/g,
    say: 'This is an npm token.' },
  { id: 'gitlab-token', level: 'error', placeholder: '<YOUR_GITLAB_TOKEN>',
    re: /\bglpat-[A-Za-z0-9_-]{16,}/g,
    say: 'This is a GitLab token.' },
  { id: 'sendgrid-key', level: 'error', placeholder: '<YOUR_SENDGRID_KEY>',
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    say: 'This is a SendGrid key.' },
  { id: 'azure-storage-key', level: 'error', placeholder: 'AccountKey=<YOUR_STORAGE_KEY>',
    re: /AccountKey=[A-Za-z0-9+/=]{40,}/g,
    say: 'This is an Azure Storage account key.' },
  { id: 'sas-token', level: 'error', placeholder: 'sig=<YOUR_SAS_SIGNATURE>',
    re: /[?&]sig=[A-Za-z0-9%+/=]{20,}/g,
    say: 'This is a shared access signature.' },
  { id: 'db-url-password', level: 'error', placeholder: '<YOUR_DATABASE_URL>',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/g,
    say: 'This connection string contains a password.' },
  { id: 'password-assignment', level: 'error', placeholder: '<YOUR_PASSWORD>',
    re: /\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*["']?([^\s"'<>,;)]{8,})["']?/gi,
    say: 'A secret is assigned a real-looking value.', group: 1 },
  { id: 'bearer', level: 'error', placeholder: 'Bearer <YOUR_TOKEN>',
    re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
    say: 'A bearer token is written out in full.' },

  { id: 'guid', level: 'warn', placeholder: '<YOUR_SUBSCRIPTION_ID>',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    say: 'A GUID - often a subscription, tenant, or account id.' },
  { id: 'email', level: 'warn', placeholder: '<YOUR_EMAIL>',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    say: 'A real email address.' },
  { id: 'home-path', level: 'warn', placeholder: '<YOUR_FOLDER>',
    re: /\b[A-Za-z]:\\Users\\[^\\\s"']+|\/(?:Users|home)\/[^/\s"']+/g,
    say: 'Your own folder path - the reader has a different name.' },
  { id: 'ip', level: 'warn', placeholder: '<YOUR_SERVER_IP>',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    say: 'An IP address.' },
  { id: 'internal-host', level: 'warn', placeholder: '<YOUR_SERVER>',
    re: /\b[a-z0-9][a-z0-9-]{2,}\.(?:internal|corp|local|intranet|lan)\b/gi,
    say: 'An internal hostname.' },
];

// Things that are obviously not secrets. Checked before anything is reported.
const SAFE = [
  /^<[A-Za-z0-9_ .-]+>$/,                       // <YOUR_API_KEY>
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/,           // $MYAPP_KEY / ${MYAPP_KEY}
  /^(?:x{3,}|\*{3,}|\.{3,}|•{3,}|_{3,})$/i,
  /example\.(?:com|org|net)/i,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.0|8\.8\.8\.8)\b/,
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  /^(?:your|my|the|some|a)[-_ ]/i,
  /:\/\/(?:user|username|admin|root|me)(?::(?:pass|passwd|password|secret|hunter2))?@/i,
  /\b(?:user|username):(?:pass|passwd|password)\b/i,
  /(?:changeme|placeholder|redacted|hidden|masked|dummy|sample|todo)/i,
  /^\d+\.\d+\.\d+$/,                            // 1.2.3 is a version, not an address
];

// ------------------------------------------------------------------ args ---

const argv = process.argv.slice(2);
const files = [];
const opts = { fix: false, json: false, strict: false, allow: null, env: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fix') opts.fix = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--strict') opts.strict = true;
  else if (a === '--allow') opts.allow = argv[++i];
  else if (a === '--env') opts.env = argv[++i];
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a.startsWith('--')) { console.error(`Unknown option ${a}`); usage(); process.exit(2); }
  else files.push(a);
}

function usage() {
  console.log(`
  node scripts/scrub.mjs <file...> [--env .env] [--fix] [--json] [--strict] [--allow scrub.allow.json]

  Finds secrets in a document before you publish it.
  Exit 0 = clean, 1 = something found.
`);
}

if (files.length === 0) { usage(); process.exit(2); }

// ------------------------------------------------------------- allowlist ---

const allowValues = new Set();
const allowPatterns = [];
const allowPath = opts.allow || findAllowFile(files[0]);
if (allowPath && fs.existsSync(allowPath)) {
  try {
    const doc = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
    for (const entry of doc.allow || []) {
      if (!entry.reason) {
        console.error(`  ${allowPath}: "${entry.value}" has no reason. Every exception needs one.`);
        process.exit(2);
      }
      allowValues.add(String(entry.value));
    }
    for (const p of doc.allowPatterns || []) allowPatterns.push(new RegExp(p));
  } catch (e) {
    console.error(`  Cannot read ${allowPath}: ${e.message}`);
    process.exit(2);
  }
}

function findAllowFile(firstFile) {
  const guess = path.join(path.dirname(path.resolve(firstFile)), 'scrub.allow.json');
  return fs.existsSync(guess) ? guess : null;
}

// Your own real values, so a copy-paste slip is caught even if no pattern matches.
const envValues = [];
if (opts.env) {
  if (!fs.existsSync(opts.env)) {
    console.error(`  Cannot find ${opts.env}`);
    process.exit(2);
  }
  for (const line of fs.readFileSync(opts.env, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value.length >= 8 && !isSafe(value)) envValues.push({ name: m[1], value });
  }
}

function isSafe(text) {
  if (allowValues.has(text)) return true;
  if (allowPatterns.some((p) => p.test(text))) return true;
  return SAFE.some((p) => p.test(text));
}

function preview(text) {
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)} (${text.length} chars)`;
}

// ------------------------------------------------------------------ scan ---

const findings = [];

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`  Cannot find ${file}`);
    process.exit(2);
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const hit = rule.group ? m[rule.group] : m[0];
        if (!hit || isSafe(hit)) continue;
        findings.push({
          file, line: index + 1, column: m.index + 1,
          rule: rule.id, level: rule.level, say: rule.say,
          match: hit, placeholder: rule.placeholder,
        });
      }
    }
    for (const ev of envValues) {
      let from = line.indexOf(ev.value);
      while (from !== -1) {
        findings.push({
          file, line: index + 1, column: from + 1,
          rule: 'env-value', level: 'error',
          say: `This is the real value of ${ev.name} from your env file.`,
          match: ev.value, placeholder: `<YOUR_${ev.name}>`,
        });
        from = line.indexOf(ev.value, from + 1);
      }
    }
  });
}

// ------------------------------------------------------------------- fix ---

if (opts.fix && findings.length) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of byFile) {
    let text = fs.readFileSync(file, 'utf8');
    // Longest first, so a short match inside a long one cannot corrupt it.
    const uniq = [...new Set(list.map((f) => f.match))].sort((a, b) => b.length - a.length);
    for (const value of uniq) {
      const item = list.find((f) => f.match === value);
      text = text.split(value).join(item.placeholder);
    }
    fs.writeFileSync(file, text, 'utf8');
    console.log(`  rewrote ${file}`);
  }
  console.log('\n  Values were replaced with placeholders. Read the file - some may need a real');
  console.log('  public value instead of a placeholder.\n');
}

// ---------------------------------------------------------------- report ---

const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

if (opts.json) {
  console.log(JSON.stringify({
    clean: errors.length === 0 && (!opts.strict || warns.length === 0),
    errors: errors.length, warnings: warns.length, findings,
  }, null, 2));
} else if (findings.length === 0) {
  console.log(`\n  Clean. No secrets found in ${files.length} file(s).\n`);
} else {
  console.log('');
  for (const f of findings) {
    const tag = f.level === 'error' ? 'SECRET ' : 'CHECK  ';
    console.log(`  ${tag} ${f.file}:${f.line}:${f.column}  [${f.rule}]`);
    console.log(`          ${f.say}`);
    console.log(`          found: ${preview(f.match)}`);
    console.log(`          use:   ${f.placeholder}`);
  }
  console.log(`\n  ${errors.length} secret(s), ${warns.length} to check.`);
  if (!opts.fix) console.log('  Run again with --fix to replace them with placeholders.');
  console.log('');
}

const failed = errors.length > 0 || (opts.strict && warns.length > 0);
process.exit(failed ? 1 : 0);

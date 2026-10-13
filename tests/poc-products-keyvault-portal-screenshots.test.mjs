/*
 * P45: PORTAL.md is illustrated with real, redacted Azure portal screenshots. Every image the guide
 * references exists and is a PNG, every PNG in the folder is referenced, the images are spread over
 * the guide's sections, and no alt text or file name carries an identifying value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { poc } from "./poc-products-keyvault.harness.mjs";

const DIR = "portal-screenshots";
const guide = () => readFileSync(join(poc, "PORTAL.md"), "utf8").replace(/\r\n/g, "\n");
const images = () => [...guide().matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ alt: m[1], src: m[2] }));
const pngs = () => readdirSync(join(poc, DIR)).filter((f) => f.endsWith(".png"));
const FORBIDDEN = /hackgw|@|MngEnv|rg-|apim-[a-z0-9]|kv-[a-z0-9]|vnet-[a-z0-9]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test("P45 every screenshot the guide references exists, is a PNG, and has alt text", () => {
  const refs = images().filter((i) => i.src.startsWith(`${DIR}/`));
  assert.ok(refs.length >= 15, `only ${refs.length} screenshots referenced`);
  for (const { alt, src } of refs) {
    assert.ok(alt.trim().length >= 10, `${src}: alt text too short`);
    const bytes = readFileSync(join(poc, src));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${src} is not a PNG`);
  }
});

test("P45 every PNG in the screenshots folder is referenced once", () => {
  const refs = images().map((i) => i.src);
  for (const f of pngs()) {
    assert.equal(refs.filter((r) => r === `${DIR}/${f}`).length, 1, `${f} is referenced ${refs.filter((r) => r === `${DIR}/${f}`).length} times`);
  }
});

test("P45 the screenshots illustrate the routes, packs, vault and key sections", () => {
  const parts = guide().split(/^## /m);
  const section = (name) => parts.find((p) => p.startsWith(`${name}\n`)) || "";
  for (const name of ["Prerequisites", "Routes", "Packs", "Key Vault", "Issue a key", "Rotate a key", "Suspend and resume a key", "List keys"]) {
    assert.match(section(name), new RegExp(`!\\[[^\\]]+\\]\\(${DIR}/`), `${name} has no screenshot`);
  }
});

test("P45 the guide says how the screenshots were taken, and nothing names a real instance", () => {
  const text = guide();
  assert.match(text, /^## Screenshots$/m, "no Screenshots section");
  const note = text.split(/^## Screenshots$/m)[1]?.split(/^## /m)[0] || "";
  for (const term of ["2026-10-13", "replaced", "not submitted", "private network"]) {
    assert.ok(note.includes(term), `the Screenshots note does not say "${term}"`);
  }
  for (const { alt, src } of images()) {
    assert.doesNotMatch(alt, FORBIDDEN, `alt text names a real value: ${alt}`);
    assert.doesNotMatch(src.replace(`${DIR}/`, "").replace(/^\d+-(apim|kv)-/, "$1-"), /hackgw|[0-9a-f]{8}-[0-9a-f]{4}/i, `file name names a real value: ${src}`);
  }
  for (const f of pngs()) assert.match(f, /^\d{2}-[a-z0-9-]+\.png$/, `${f}: not a numbered, lower-case name`);
});

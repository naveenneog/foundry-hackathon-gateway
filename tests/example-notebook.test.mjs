import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The worked example is executed before it is committed, so its outputs are real. That is the
 * point of it — and it is also the risk: a notebook run with a live key can capture that key in
 * a cell output, and `examples/` is NOT gitignored the way `handouts/` is.
 *
 * These tests are the guard. They also pin the two mistakes the notebook exists to prevent a
 * participant making, so the example cannot quietly stop teaching them.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "examples/claude-agent.ipynb");
const raw = fs.readFileSync(file, "utf8");
const nb = JSON.parse(raw);

const codeCells = nb.cells.filter((c) => c.cell_type === "code");
const outputText = codeCells
  .flatMap((c) => c.outputs ?? [])
  .flatMap((o) => [o.text ?? "", o.data?.["text/plain"] ?? "", o.evalue ?? ""])
  .flat()
  .join("\n");

describe("the example notebook carries no credential", () => {
  test("it is a notebook with executed code cells — otherwise this proves nothing", () => {
    assert.equal(nb.nbformat, 4);
    assert.ok(codeCells.length >= 5, `Found ${codeCells.length} code cells.`);
    assert.ok(outputText.length > 200, "No captured output; the notebook was not executed.");
  });

  test("no JWT appears anywhere in the file", () => {
    // Three dot-separated base64url segments: a signed token, not a header fragment.
    const tokens = raw.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g) ?? [];
    assert.deepEqual(tokens, [], "A participant key is embedded in the notebook.");
  });

  test("no token fragment appears either", () => {
    const fragments = raw.match(/eyJ[A-Za-z0-9_-]{5,}/g) ?? [];
    assert.deepEqual(fragments, [], `Token-shaped text in the notebook: ${fragments.join(", ")}`);
  });

  test("the key is read from the environment, never written in a cell", () => {
    const source = codeCells.map((c) => c.source.join("")).join("\n");
    assert.match(source, /os\.environ(\.get)?\(\s*["']ANTHROPIC_AUTH_TOKEN["']/);
  });
});

describe("the example still teaches the two things that catch people out", () => {
  const allText = nb.cells.map((c) => c.source.join("")).join("\n");

  test("it says to use ANTHROPIC_AUTH_TOKEN rather than ANTHROPIC_API_KEY", () => {
    assert.match(allText, /ANTHROPIC_AUTH_TOKEN/);
    assert.match(allText, /x-api-key/, "The reason API_KEY fails is not explained.");
  });

  test("it warns against shortening the alias to a Claude Code model slot", () => {
    assert.match(
      allText,
      /sonnet.{0,40}opus.{0,40}haiku|`sonnet`/s,
      "Nothing warns that a bare family name is resolved client-side."
    );
  });

  test("it passes auth_token to the client, not api_key", () => {
    const source = codeCells.map((c) => c.source.join("")).join("\n");
    assert.match(source, /auth_token\s*=\s*AUTH_TOKEN/);
    assert.ok(
      !/api_key\s*=\s*AUTH_TOKEN/.test(source),
      "api_key would be sent as x-api-key and the gateway would reject it."
    );
  });

  test("it uses input_schema, the Messages API tool shape", () => {
    const source = codeCells.map((c) => c.source.join("")).join("\n");
    assert.match(source, /input_schema/);
    assert.ok(
      !/"type":\s*"function"/.test(source),
      "That is the OpenAI tool shape; this route speaks the Messages API."
    );
  });
});

describe("the recorded run actually exercised the agent loop", () => {
  test("the model called both tools", () => {
    assert.match(outputText, /get_order_status/, "No order lookup in the captured output.");
    assert.match(outputText, /calculate/, "No calculator call in the captured output.");
  });

  test("it reached a final answer with the right arithmetic", () => {
    // 129.50 + 74.25. A wrong total means the loop fed tool results back incorrectly.
    assert.match(outputText, /203\.75/, "The combined total is missing or wrong.");
  });

  test("the gateway's governance headers were visible to the caller", () => {
    assert.match(outputText, /x-governed-by\s+foundry-hackathon-gateway/);
    assert.match(outputText, /x-budget-remaining/);
  });
});

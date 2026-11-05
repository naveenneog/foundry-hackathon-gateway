// Writes the compacted gateway policies that infra/main.bicep deploys (API Management v2 refuses
// policy documents over 16 KiB). Run after editing infra/policy.xml or infra/policy-claude.xml;
// tests/policy-size.test.mjs fails while a compacted copy is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { compactPolicy } from "../src/policy-compact.mjs";

const root = new URL("../", import.meta.url);
for (const name of ["policy", "policy-claude"]) {
  const out = compactPolicy(readFileSync(new URL(`infra/${name}.xml`, root), "utf8"));
  writeFileSync(new URL(`infra/${name}.min.xml`, root), out);
  console.log(`infra/${name}.min.xml  ${Buffer.byteLength(out)} bytes`);
}

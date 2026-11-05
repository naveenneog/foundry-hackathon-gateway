/**
 * API Management v2 refuses an API policy document over 16 KiB ("Policy size exceeds allowed
 * limit of 16 KB"; measured 2026-10-23). The source policies carry long comments, so deployed
 * copies drop XML comments, whole-line `//` comments in policy expressions, and indentation.
 * Governance statements are unchanged; the sources stay readable.
 */
export const POLICY_LIMIT_BYTES = 16 * 1024;

export function compactPolicy(xml) {
  const compact = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "").split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
  if (Buffer.byteLength(compact) > POLICY_LIMIT_BYTES) throw new Error("Policy exceeds API Management's 16 KiB limit after removing comments and formatting.");
  return compact;
}

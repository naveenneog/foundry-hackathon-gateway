/**
 * The `hackgw-revoked-keys` named value: `,jti1,jti2,` — the policies test `contains(",<jti>,")`,
 * so the leading and trailing commas are load-bearing. An empty list is ",".
 */

const JTI_RE = /^k_[0-9a-f]{16}$/;

const parse = (list) => String(list ?? "").split(",").filter(Boolean);
const format = (items) => (items.length ? `,${items.join(",")},` : ",");
const check = (jti) => {
  if (!JTI_RE.test(String(jti))) throw new Error(`Not a key jti: ${jti}`);
  return jti;
};

export const isRevoked = (list, jti) => parse(list).includes(jti);

export function addRevoked(list, jti) {
  const items = parse(list);
  if (!items.includes(check(jti))) items.push(jti);
  return format(items);
}

export function removeRevoked(list, jti) {
  check(jti);
  return format(parse(list).filter((j) => j !== jti));
}

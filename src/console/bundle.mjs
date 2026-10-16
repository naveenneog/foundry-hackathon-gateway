/**
 * Secure export bundles: encrypted for the recipient, signed by the console.
 *
 * - Confidentiality: AES-256-GCM under a key derived with scrypt from a passphrase the admin
 *   sends to the recipient over a different channel than the file.
 * - Integrity + origin: the canonical header (who exported, when, for whom, what, the KDF and
 *   cipher parameters and the ciphertext's SHA-256) is signed ES256 by a non-exportable Key Vault
 *   key. The header without the hash is the GCM additional data, so neither part can be swapped.
 *
 * `openBundle` verifies the signature and the ciphertext hash BEFORE attempting decryption.
 * ADR-0013 decision 6.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, verify } from "node:crypto";

export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleError";
  }
}

const MIN_PASSPHRASE = 16;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const canonicalHeader = (header) => Buffer.from(JSON.stringify(canonical(header)), "utf8");

const deriveKey = (passphrase, salt, { N, r, p }) =>
  scryptSync(passphrase.normalize("NFKC"), salt, 32, { N, r, p, maxmem: SCRYPT_MAXMEM });

/** 144 random bits, shown once to the admin. */
export const generatePassphrase = () => randomBytes(18).toString("base64url");

export async function createBundle({ payload, passphrase, admin, recipient, contents, signer, now = Date.now() }) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) {
    throw new BundleError(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
  if (!admin?.name) throw new BundleError("An admin identity is required to sign a bundle.");
  if (!signer?.signDigest || !signer.kid) throw new BundleError("A signer is required.");

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, SCRYPT);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");

  const base = {
    v: 1,
    alg: "ES256",
    kid: signer.kid,
    issuedAt: new Date(now).toISOString(),
    issuedBy: { name: admin.name, oid: admin.oid ?? "" },
    recipient: String(recipient ?? ""),
    contents: (contents ?? []).map(String),
    kdf: { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT },
    enc: { name: "A256GCM", iv: iv.toString("base64") },
  };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(canonicalHeader(base));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = { ...base, ciphertextSha256: createHash("sha256").update(ciphertext).digest("base64") };
  const data = canonicalHeader(header);
  const digest = createHash("sha256").update(data).digest();
  const signature = Buffer.from(await signer.signDigest(digest, data));
  if (signature.length !== 64) throw new BundleError("The signer did not return a raw ES256 signature.");

  return { header, signature: signature.toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function openBundle(bundle, { passphrase, publicJwk }) {
  const { header, signature, ciphertext } = bundle ?? {};
  if (!header || typeof signature !== "string" || typeof ciphertext !== "string") {
    throw new BundleError("Not a bundle: header, signature and ciphertext are required.");
  }
  if (header.v !== 1 || header.alg !== "ES256" || header.enc?.name !== "A256GCM" || header.kdf?.name !== "scrypt") {
    throw new BundleError("Unsupported bundle version or algorithm.");
  }
  const ok = verify("sha256", canonicalHeader(header),
    { key: publicJwk, format: "jwk", dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64"));
  if (!ok) throw new BundleError("Bad signature: this bundle was not signed by the console key, or its header was changed.");

  const ct = Buffer.from(ciphertext, "base64");
  if (createHash("sha256").update(ct).digest("base64") !== header.ciphertextSha256) {
    throw new BundleError("Ciphertext hash mismatch: the bundle was tampered with.");
  }
  const { N, r, p } = header.kdf;
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 16 || p > 4) {
    throw new BundleError("Unsupported KDF parameters.");
  }
  const { ciphertextSha256: _omit, ...base } = header;
  try {
    const key = deriveKey(String(passphrase ?? ""), Buffer.from(header.kdf.salt, "base64"), { N, r, p });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.enc.iv, "base64"));
    decipher.setAAD(canonicalHeader(base));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    return { header, payload: JSON.parse(plain.toString("utf8")) };
  } catch {
    throw new BundleError("Could not decrypt: wrong passphrase.");
  }
}

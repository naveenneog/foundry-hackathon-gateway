/**
 * The alias -> Foundry deployment map.
 *
 * Participants ask for a friendly alias (`flash`); the backend needs the real deployment name
 * (`deepseek-v4-flash`). Aliasing means a model can be repointed or added without a single
 * participant editing their config.
 *
 * WHY A SINGLE DELIMITED STRING, rather than one named value per model:
 * APIM substitutes {{named-value}} at policy COMPILE time, not at runtime, so a policy cannot
 * build a reference like {{model-}} + alias. Microsoft's documented workaround is to hold every
 * value in one named value and parse it with a policy expression. That is this module, and
 * infra/policy.xml is its transcription.
 *
 * The happy consequence: adding a model is a named-value edit, with no redeployment.
 *
 * Wire format:  alias=deployment;alias=deployment
 */

export class ModelMapError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelMapError";
  }
}

const PAIR_SEP = ";";
const KV_SEP = "=";

/**
 * Parse the wire format into a plain alias -> deployment object.
 *
 * Never throws. A malformed entry is skipped rather than taking out the whole map, because a
 * single typo in a named value must not strand every participant at an event.
 *
 * @param {string} raw
 * @returns {Record<string,string>}
 */
export function parseModelMap(raw) {
  // Object.create(null): no prototype, so "constructor" and "__proto__" cannot masquerade as
  // configured models.
  const map = Object.create(null);
  if (typeof raw !== "string" || raw.trim() === "") return map;

  for (const entry of raw.split(PAIR_SEP)) {
    const idx = entry.indexOf(KV_SEP);
    if (idx <= 0) continue;

    const alias = entry.slice(0, idx).trim().toLowerCase();
    const deployment = entry.slice(idx + 1).trim();
    if (alias === "" || deployment === "") continue;

    // First definition wins, so behaviour is deterministic if a duplicate ever reaches here.
    // buildModelMap rejects duplicates up front.
    if (!(alias in map)) map[alias] = deployment;
  }
  return map;
}

/**
 * Resolve an alias to its deployment name, or null if it is not configured.
 * @returns {string|null}
 */
export function resolveAlias(map, alias) {
  if (!map || typeof alias !== "string") return null;
  const key = alias.trim().toLowerCase();
  if (key === "") return null;
  // Own-property check only: an alias must be configured, not inherited.
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/**
 * Serialise pairs into the wire format, rejecting anything that would corrupt it.
 *
 * @param {{alias: string, deployment: string}[]} pairs
 * @returns {string}
 */
export function buildModelMap(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new ModelMapError("At least one model must be configured.");
  }

  const seen = new Set();
  const out = [];

  for (const pair of pairs) {
    const alias = String(pair?.alias ?? "").trim().toLowerCase();
    const deployment = String(pair?.deployment ?? "").trim();

    if (alias === "") throw new ModelMapError("Model alias cannot be empty.");
    if (deployment === "") throw new ModelMapError(`Deployment name for alias '${alias}' cannot be empty.`);

    // The separators are structural. A value containing one would silently split the map.
    for (const [label, value] of [["alias", alias], ["deployment name", deployment]]) {
      if (value.includes(PAIR_SEP) || value.includes(KV_SEP)) {
        throw new ModelMapError(
          `The ${label} '${value}' contains '${PAIR_SEP}' or '${KV_SEP}', which are reserved separators.`
        );
      }
    }

    if (seen.has(alias)) {
      throw new ModelMapError(
        `Alias '${alias}' is defined more than once. Each alias must map to exactly one deployment.`
      );
    }
    seen.add(alias);

    out.push(`${alias}${KV_SEP}${deployment}`);
  }

  return out.join(PAIR_SEP);
}

/** The aliases a map defines, sorted, for display. */
export function listAliases(map) {
  return Object.keys(map || {}).sort();
}

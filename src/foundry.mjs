/**
 * The models actually deployed across the subscription, and which route can serve each one.
 *
 * WHY THE WIRE FORMAT IS PART OF WHAT A DEPLOYMENT IS:
 * A Foundry account serves Claude models on `/anthropic`, in the Anthropic Messages format, and
 * everything else on `/openai/v1`, in the OpenAI Chat Completions format. The two are different
 * endpoints with different request bodies. Pinning a Claude deployment to the OpenAI route gives
 * a gateway that authenticates, forwards, and returns a 404 from a backend that has never heard
 * of the model — which reads as a gateway fault rather than a pin that was never possible.
 *
 * So a pin that crosses routes is refused where the pin is made, not discovered by a participant.
 *
 * Pure functions over the shapes `az cognitiveservices account list` and
 * `... account deployment list` return. scripts/Models.ps1 is the transcription.
 */

export const WIRE = {
  OPENAI: "openai-chat-completions",
  ANTHROPIC: "anthropic-messages",
  UNKNOWN: "unknown",
};

/** Which route serves which wire format. Mirrors ROUTE in src/apim.mjs. */
const ROUTE_FOR_WIRE = {
  [WIRE.OPENAI]: "openai",
  [WIRE.ANTHROPIC]: "claude",
};

/**
 * Model formats ARM reports for models served on the OpenAI-compatible endpoint.
 * An unlisted format is UNKNOWN rather than assumed, because assuming puts a model on a route
 * that cannot serve it.
 */
const OPENAI_FORMATS = new Set(["openai", "deepseek", "meta", "mistral ai", "mistral", "microsoft", "xai", "ai21 labs"]);
const ANTHROPIC_FORMATS = new Set(["anthropic"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The wire format a deployment speaks.
 *
 * The model name is checked as well as the format: a Claude deployment whose `format` field is
 * missing must not fall through to the OpenAI route.
 *
 * @param {object} deployment  an entry from `az cognitiveservices account deployment list`
 * @returns {string} a WIRE value
 */
export function wireFormatOf(deployment) {
  if (!deployment || typeof deployment !== "object") return WIRE.UNKNOWN;

  const model = deployment.properties?.model ?? {};
  const format = text(model.format).toLowerCase();
  const name = text(model.name).toLowerCase();

  if (ANTHROPIC_FORMATS.has(format) || name.startsWith("claude")) return WIRE.ANTHROPIC;
  if (OPENAI_FORMATS.has(format)) return WIRE.OPENAI;
  return WIRE.UNKNOWN;
}

/** The route that serves a wire format, or null when nothing does. */
export function routeFor(wire) {
  return ROUTE_FOR_WIRE[text(wire)] ?? null;
}

/**
 * Flatten every account's deployments into one list.
 *
 * Deployments that are not ready are kept and marked: hiding one is indistinguishable from it
 * not existing, and the usual reason is that it is still being created.
 *
 * @param {{name: string, resourceGroup: string, location?: string, deployments?: object[]}[]} accounts
 */
export function buildCatalogue(accounts) {
  if (!Array.isArray(accounts)) return [];

  const out = [];
  for (const account of accounts) {
    for (const d of account?.deployments ?? []) {
      const model = d?.properties?.model ?? {};
      const wire = wireFormatOf(d);
      const state = text(d?.properties?.provisioningState);
      out.push({
        account: text(account?.name),
        resourceGroup: text(account?.resourceGroup),
        location: text(account?.location),
        deployment: text(d?.name),
        model: text(model.name),
        version: text(model.version),
        format: text(model.format),
        wire,
        route: routeFor(wire),
        state,
        ready: state === "" || state.toLowerCase() === "succeeded",
      });
    }
  }
  return out;
}

/**
 * Whether a catalogue entry may be pinned to a route.
 *
 * @param {object} entry  an entry from buildCatalogue
 * @param {string} route  "openai" or "claude"
 * @returns {{allowed: boolean, reason: string}}
 */
export function canPin(entry, route) {
  const wanted = text(route);

  if (!entry || typeof entry !== "object") {
    return { allowed: false, reason: "That deployment could not be read." };
  }

  if (entry.wire === WIRE.UNKNOWN) {
    return {
      allowed: false,
      reason:
        `'${entry.deployment}' reports the model format '${entry.format || "none"}', which this gateway ` +
        `does not know how to route. Add it to src/foundry.mjs once you know which endpoint serves it.`,
    };
  }

  if (entry.route !== wanted) {
    const shape = entry.wire === WIRE.ANTHROPIC ? "the Anthropic Messages API" : "OpenAI Chat Completions";
    return {
      allowed: false,
      reason:
        `'${entry.deployment}' speaks ${shape}, which the '${entry.route}' route serves. Pinning it to ` +
        `'${wanted}' would forward every request to an endpoint that has never heard of the model.`,
    };
  }

  if (!entry.ready) {
    return {
      allowed: false,
      reason: `'${entry.deployment}' is ${entry.state}, not Succeeded. It would return 404 until it finishes.`,
    };
  }

  return { allowed: true, reason: "" };
}

/**
 * A short alias to offer the operator. Participants type this, so it is kept small and legal.
 *
 * `;` and `=` are the model map's structural separators and are stripped rather than escaped;
 * see ADR-0007.
 */
export function suggestAlias(deploymentName) {
  const name = text(deploymentName).toLowerCase();
  if (name === "") return "";

  // claude-sonnet-4-6 -> sonnet, claude-opus-4-8 -> opus
  const claude = name.match(/^claude-([a-z]+)/);
  if (claude) return claude[1];

  return name
    .replace(/^deepseek-v\d+-/, "")
    .replace(/[^a-z0-9-]/g, "");
}

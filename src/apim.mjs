/**
 * Deciding whether an API Management instance an organisation already runs can host this
 * gateway, and what deploying onto it would do.
 *
 * WHY THE TIER IS A REFUSAL AND NOT A WARNING:
 * `llm-token-limit` parses the Anthropic Messages response shape only on v2 tiers. A classic
 * tier accepts the identical policy, reports no error, and meters zero tokens — so every budget
 * is configured, displayed as configured, and enforces nothing. A control that cannot fire is
 * worse than an absent one, because nobody goes looking for it. See UNKNOWNS U12 and ADR-0008.
 *
 * The OpenAI Chat Completions shape parses on all tiers, so the same instance can be perfectly
 * fine for the DeepSeek route and unusable for the Claude route. The route is therefore part of
 * the question, not a detail.
 *
 * Pure functions over the shapes `az apim list` and `az role assignment list` return, so the
 * decision is unit-testable without a subscription. scripts/Apim.ps1 is its transcription.
 */

/** The routes this gateway can serve, and the API id each one deploys. */
export const ROUTE = {
  OPENAI: "openai",
  CLAUDE: "claude",
};

const API_ID = {
  [ROUTE.OPENAI]: "deepseek-gateway",
  [ROUTE.CLAUDE]: "claude-gateway",
};

/**
 * The APIM path each route publishes at. Paths are unique per instance, so an adopted instance
 * that already serves something at this path cannot take the API.
 *
 * `claude` is the base a Claude client is pointed at; the client appends `/v1/messages` itself.
 */
const API_PATH = {
  [ROUTE.OPENAI]: "v1",
  [ROUTE.CLAUDE]: "claude",
};

export const UNSUITABLE = {
  MALFORMED: "malformed",
  UNKNOWN_ROUTE: "unknown_route",
  CLASSIC_TIER: "classic_tier",
  CONSUMPTION_TIER: "consumption_tier",
  NOT_READY: "not_ready",
  NO_IDENTITY: "no_identity",
  PATH_TAKEN: "path_taken",
};

const BLOCKER_REASON = {
  [UNSUITABLE.MALFORMED]:
    "This instance could not be read, so it is not offered. Re-run discovery, or name the instance explicitly.",
  [UNSUITABLE.UNKNOWN_ROUTE]:
    "Unknown route. A new route has to state its own tier requirements before an instance can be judged against it.",
  [UNSUITABLE.CLASSIC_TIER]:
    "The Claude route needs a v2 tier (BasicV2, StandardV2 or PremiumV2). A classic tier accepts the token policy and meters zero Anthropic tokens, so budgets would never fire and the cap would silently not exist.",
  [UNSUITABLE.CONSUMPTION_TIER]:
    "The Consumption tier supports neither named values nor a managed identity, which this gateway needs for the model map, the signing key and backend authentication.",
  [UNSUITABLE.NOT_READY]:
    "The instance is not in the Succeeded state, so it cannot accept an API yet. Wait for the current operation to finish.",
  [UNSUITABLE.NO_IDENTITY]:
    "The instance has no system-assigned managed identity, which is the principal this gateway grants Foundry access to. Enable it with `az apim update -n <name> -g <rg> --enable-managed-identity true`, or the portal's Managed identities toggle. The flag is not optional: az apim update sets identity to None when it is omitted, which would strip the identity from any other API on the instance that depends on it.",
};

/** ARM spells the v2 tiers BasicV2 / StandardV2 / PremiumV2. */
const isV2 = (sku) => /v2$/i.test(sku);
const isConsumption = (sku) => /^consumption$/i.test(sku);

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Judge one instance against one route.
 *
 * Never throws: discovery runs over whatever `az` returned, and one malformed entry must not
 * hide the rest of the subscription.
 *
 * @param {object} instance  an entry from `az apim list`
 * @param {{route: string, existingApis?: string[]}} options
 * @returns {{name: string, sku: string, location: string, resourceGroup: string,
 *            suitable: boolean, blockers: string[], reason: string,
 *            action: "add"|"update"|"none", note: string}}
 */
export function classifyApim(instance, options = {}) {
  const route = text(options.route);
  const blockers = [];

  const sku = text(instance?.sku?.name);
  const name = text(instance?.name);
  if (!instance || typeof instance !== "object" || name === "" || sku === "") {
    blockers.push(UNSUITABLE.MALFORMED);
  }

  if (!Object.prototype.hasOwnProperty.call(API_ID, route)) {
    blockers.push(UNSUITABLE.UNKNOWN_ROUTE);
  }

  if (sku !== "") {
    if (isConsumption(sku)) {
      blockers.push(UNSUITABLE.CONSUMPTION_TIER);
      // Consumption is also not v2, and for the Claude route the metering reason is the one an
      // operator needs to hear, so both are reported.
      if (route === ROUTE.CLAUDE) blockers.push(UNSUITABLE.CLASSIC_TIER);
    } else if (route === ROUTE.CLAUDE && !isV2(sku)) {
      blockers.push(UNSUITABLE.CLASSIC_TIER);
    }
  }

  const state = text(instance?.provisioningState);
  if (state !== "" && state.toLowerCase() !== "succeeded") {
    blockers.push(UNSUITABLE.NOT_READY);
  }

  // The gateway calls Foundry as the instance itself. "SystemAssigned, UserAssigned" counts:
  // the system half is what authentication-managed-identity requests.
  if (!/systemassigned/i.test(text(instance?.identity?.type))) {
    blockers.push(UNSUITABLE.NO_IDENTITY);
  }

  // Exact match. A prefix match would read "claude-gateway-v2" as this gateway's own API and
  // offer to "update" something it did not create.
  const apiId = API_ID[route];
  const existingApis = Array.isArray(options.existingApis) ? options.existingApis.map(text) : [];
  const carriesApi = apiId !== undefined && existingApis.includes(apiId);

  // APIM paths are unique per instance. A different API already serving this path makes the
  // deployment fail, so it is a blocker rather than a surprise at deploy time.
  const wantedPath = normalisePath(API_PATH[route]);
  const clash = (Array.isArray(options.existingPaths) ? options.existingPaths : []).find(
    (p) => normalisePath(p?.path) === wantedPath && text(p?.name) !== apiId
  );
  if (wantedPath !== "" && clash) {
    blockers.push(UNSUITABLE.PATH_TAKEN);
  }

  const suitable = blockers.length === 0;
  const action = suitable ? (carriesApi ? "update" : "add") : "none";

  const reasons = blockers.map((b) =>
    b === UNSUITABLE.PATH_TAKEN
      ? `The API '${text(clash?.name)}' already serves the path '${wantedPath}' on this instance, and APIM requires paths to be unique. Publish this gateway on an instance where '${wantedPath}' is free.`
      : BLOCKER_REASON[b]
  );

  return {
    name,
    sku,
    location: text(instance?.location),
    resourceGroup: text(instance?.resourceGroup),
    suitable,
    blockers,
    reason: suitable ? suitableReason(sku, carriesApi, apiId) : reasons.join(" "),
    action,
    note: carriesApi
      ? `Already carries the '${apiId}' API; deploying would update it in place.`
      : suitable
        ? `Would add the '${apiId}' API to this instance.`
        : "",
  };
}

/** APIM treats `/V1/` and `v1` as the same path. */
const normalisePath = (value) => text(value).toLowerCase().replace(/^\/+|\/+$/g, "");

function suitableReason(sku, carriesApi, apiId) {
  return carriesApi
    ? `${sku}. Already carries '${apiId}' — this is the instance currently serving it.`
    : `${sku}. Usable; the '${apiId}' API would be added alongside anything already published here.`;
}

/**
 * Judge every instance, usable ones first.
 *
 * Unusable instances stay in the list. Hiding one is indistinguishable from it not existing,
 * which sends an operator hunting for an instance that is sitting right there with a fixable
 * problem.
 *
 * @param {object[]} list  the output of `az apim list`
 * @param {{route: string, existingApisByName?: Record<string,string[]>}} options
 */
export function rankApim(list, options = {}) {
  if (!Array.isArray(list)) return [];
  const byName = options.existingApisByName || {};
  const pathsByName = options.existingPathsByName || {};

  return list
    .map((instance) =>
      classifyApim(instance, {
        route: options.route,
        existingApis: byName[text(instance?.name)],
        existingPaths: pathsByName[text(instance?.name)],
      })
    )
    .sort((a, b) => {
      if (a.suitable !== b.suitable) return a.suitable ? -1 : 1;
      // The instance already serving this API is the one being operated; offer it first.
      const aUpdate = a.action === "update";
      const bUpdate = b.action === "update";
      if (aUpdate !== bUpdate) return aUpdate ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

const normaliseScope = (scope) => text(scope).toLowerCase().replace(/\/+$/, "");
/** ARM returns a full role-definition path; the caller holds a bare GUID. Compare the GUID. */
const roleId = (value) => text(value).toLowerCase().split("/").filter(Boolean).pop() || "";

/**
 * Whether the Foundry role assignment still has to be created.
 *
 * Creating one that already exists fails the whole deployment with RoleAssignmentExists, and
 * `what-if` does not predict it — the sibling project hit this live.
 *
 * Unreadable input returns true rather than false: skipping a grant the gateway needs produces
 * 401s from Foundry that read as a policy fault, whereas a redundant create is rejected by ARM
 * with an error that names itself.
 *
 * @param {object[]|null} existing  entries from `az role assignment list`
 * @param {{principalId: string, scope: string, roleDefinitionId: string}} wanted
 */
export function needsRoleAssignment(existing, wanted) {
  if (!Array.isArray(existing)) return true;

  const principal = text(wanted?.principalId).toLowerCase();
  const scope = normaliseScope(wanted?.scope);
  const role = roleId(wanted?.roleDefinitionId);
  if (principal === "" || scope === "" || role === "") return true;

  return !existing.some(
    (a) =>
      text(a?.principalId).toLowerCase() === principal &&
      normaliseScope(a?.scope) === scope &&
      roleId(a?.roleDefinitionId) === role
  );
}

/** The API id a route publishes, so callers do not re-derive it. */
export function apiIdForRoute(route) {
  return API_ID[text(route)] ?? null;
}

/** The APIM path a route publishes at. */
export function apiPathForRoute(route) {
  return API_PATH[text(route)] ?? null;
}

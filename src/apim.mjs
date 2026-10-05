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
    "The Claude route is published only on a v2 tier (BasicV2, StandardV2 or PremiumV2), which is where API Management supports Anthropic Messages token metering. This SKU is not one of them, and on an unsupported tier the token policy is accepted and meters zero, so budgets would never fire.",
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

/**
 * What a deployment would do to a target, worked out before it runs.
 *
 * An ARM deployment is atomic: one resource that cannot be created fails the whole thing. That
 * happened live — an instance already published an API at `claude`, and an unrelated gateway had
 * already granted the Foundry role. The deployment failed on both and left behind the API it had
 * already created, so the operator had a wall of ARM JSON and a half-built gateway.
 *
 * This answers what that wall did not: what is already here, what will be added, and what cannot
 * be done and why. The caller shows it and stops on any BLOCKED row.
 */
export const PLAN = {
  CREATE: "create",
  UPDATE: "update",
  REUSE: "reuse",
  OK: "ok",
  SKIP: "skip",
  BLOCKED: "blocked",
};

export function buildDeploymentPlan(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const apim = f.apim ?? {};
  const foundry = f.foundry ?? {};
  const pins = Array.isArray(f.pins) ? f.pins : [];
  const existingApis = Array.isArray(f.existingApis) ? f.existingApis : [];
  const existingPaths = Array.isArray(f.existingPaths) ? f.existingPaths : [];
  const namedValues = Array.isArray(f.namedValues) ? f.namedValues : [];
  const rows = [];

  const add = (component, action, detail) => rows.push({ component, action, detail });

  // --- the instance ---
  if (apim.exists) {
    add("API Management", PLAN.REUSE, `${text(apim.name)} (${text(apim.sku) || "unknown SKU"}) is reused as-is.`);
  } else {
    add("API Management", PLAN.CREATE, `${text(apim.name) || "a new instance"} will be created. This takes 30-45 minutes.`);
  }

  // --- the Foundry account and every pinned model ---
  const deployments = Array.isArray(foundry.deployments) ? foundry.deployments.map(text) : [];
  if (foundry.exists === false) {
    add("Foundry account", PLAN.BLOCKED, `'${text(foundry.name)}' was not found. Every model call would return 404.`);
  } else {
    add("Foundry account", PLAN.OK, `${text(foundry.name)}, ${deployments.length} deployment(s).`);
  }

  for (const pin of pins) {
    const dep = text(pin?.deployment);
    const label = `Model: ${text(pin?.alias)}`;
    if (foundry.exists === false) {
      add(label, PLAN.BLOCKED, `'${dep}' cannot be checked: the account is missing.`);
    } else if (deployments.includes(dep)) {
      add(label, PLAN.OK, `${dep} (${text(pin?.route) || "openai"}).`);
    } else {
      add(label, PLAN.BLOCKED, `'${dep}' is not deployed in ${text(foundry.name)}. Calls would return 404 DeploymentNotFound.`);
    }
  }

  // --- the two routes ---
  for (const route of [ROUTE.OPENAI, ROUTE.CLAUDE]) {
    const label = route === ROUTE.OPENAI ? "OpenAI route" : "Claude route";
    const apiId = API_ID[route];
    const wanted = pins.filter((p) => (text(p?.route) || ROUTE.OPENAI) === route);

    // Only the caller knows it has decided not to publish the Claude route (a classic tier, or
    // an alternative path declined). Having no Claude pins is NOT that decision: the deployment
    // still publishes the route, with EMPTY_MAP, so a model pinned later goes live without a
    // redeploy. An earlier version reported that case as "not published".
    if (route === ROUTE.CLAUDE && f.deployClaude === false) {
      if (existingApis.includes(apiId)) {
        // ARM deploys incrementally: a resource the template no longer declares is left alone,
        // not removed. Saying "not published" here would hide a live API.
        add(label, PLAN.SKIP, `Not updated by this deployment. '${apiId}' already exists on this instance and is left in place as it is, including its policy.`);
      } else {
        add(
          label,
          PLAN.SKIP,
          wanted.length > 0
            ? `Not published on this instance, so ${wanted.length} Claude pin(s) will be unreachable.`
            : "Not published on this instance."
        );
      }
      continue;
    }

    const nothingPinned =
      wanted.length === 0
        ? " Nothing is pinned on this route, so it answers model_not_configured until a model is (option 3, no redeploy)."
        : "";

    // The path the deployment will actually use, which is not always the default: a collision
    // can be worked around by publishing elsewhere, and the caller passes the path it settled
    // on. Judging the default here would report a route blocked that is about to be published.
    const resolvedPath =
      route === ROUTE.CLAUDE && text(f.claudePath) ? normalisePath(f.claudePath) : normalisePath(API_PATH[route]);

    const verdict = classifyApim(
      {
        name: apim.name,
        // classifyApim reads the ARM shape, where the SKU is an object.
        sku: { name: apim.sku },
        provisioningState: "Succeeded",
        identity: apim.hasIdentity === false ? { type: "None" } : { type: "SystemAssigned" },
      },
      { route, existingApis, existingPaths }
    );

    // A path collision is the one blocker a different path fixes. Everything else - the tier
    // above all - travels with the instance, so it has to be judged on its own. These arrive in
    // the same array, and an earlier version let the path branch mask the tier: an instance that
    // was BOTH on a classic tier and had the path taken was reported CREATE, which would have
    // published a Claude route whose token cap meters nothing.
    const incurable = (verdict.blockers ?? []).filter((b) => b !== UNSUITABLE.PATH_TAKEN);
    const clash = existingPaths.find((p) => normalisePath(p?.path) === resolvedPath && text(p?.name) !== apiId);

    if (apim.exists && incurable.length > 0) {
      add(label, PLAN.BLOCKED, verdict.reason);
    } else if (apim.exists && clash) {
      add(label, PLAN.BLOCKED, `'${text(clash.name)}' already serves the path '${resolvedPath}', and APIM requires paths to be unique.`);
    } else if (existingApis.includes(apiId)) {
      add(label, PLAN.UPDATE, `'${apiId}' is already published; its policy and operations are updated.${nothingPinned}`);
    } else {
      add(label, PLAN.CREATE, `'${apiId}' will be added at /${resolvedPath}.${nothingPinned}`);
    }
  }

  // --- configuration and access ---
  const ours = namedValues.filter((n) => text(n).startsWith("hackgw-"));
  add(
    "Named values",
    ours.length > 0 ? PLAN.UPDATE : PLAN.CREATE,
    ours.length > 0 ? `${ours.length} already present; values are refreshed.` : "The gateway's named values will be created."
  );

  add(
    "Foundry access",
    f.roleAssigned ? PLAN.OK : PLAN.CREATE,
    f.roleAssigned
      ? "The gateway identity already has Cognitive Services User; not re-granting."
      : "Cognitive Services User will be granted to the gateway identity."
  );

  return rows;
}

/**
 * A path on the instance that nothing else is using.
 *
 * APIM requires paths to be unique. An instance already running another Claude gateway owns
 * `claude`, and refusing outright means that instance can never serve this route — the wrong
 * answer when the operator chose it deliberately. The caller offers the result rather than
 * applying it silently, because the path is in every participant's base URL.
 *
 * @param {{name: string, path: string}[]} existingPaths  from `az apim api list`
 * @param {string} preferred  the route's normal path
 * @param {string} [ownApiId] an API with this id holding the path is ours, not a collision
 */
export function suggestFreePath(existingPaths, preferred, ownApiId) {
  const wanted = normalisePath(preferred);
  const list = Array.isArray(existingPaths) ? existingPaths : [];
  const mine = text(ownApiId);

  const taken = new Set(
    list
      .filter((p) => p && typeof p === "object" && text(p.name) !== mine)
      .map((p) => normalisePath(p.path))
      .filter((p) => p !== "")
  );

  if (!taken.has(wanted)) return wanted;

  const alt = `${wanted}-hackgw`;
  if (!taken.has(alt)) return alt;

  for (let n = 2; n < 100; n++) {
    const candidate = `${alt}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${alt}-${Date.now()}`;
}

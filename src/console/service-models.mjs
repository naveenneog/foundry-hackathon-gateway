/** Console service: Foundry deployments and model pinning (P49). Composed into createService. */

import { buildCatalogue } from "../foundry.mjs";
import { pinsFromMaps, mapsFromPins, applyPin, applyUnpin, describeDeployments } from "./pinning.mjs";

export const MAP_NAMES = { openai: "hackgw-model-map", claude: "hackgw-claude-model-map" };

export function modelsApi({ arm, foundry, requireAdmin, audit, guard }) {
  async function catalogue() {
    if (!foundry) return [];
    return buildCatalogue([await foundry.getAccount()]);
  }

  async function currentPins() {
    const [o, c] = await Promise.all([arm.getNamedValue(MAP_NAMES.openai), arm.getNamedValue(MAP_NAMES.claude)]);
    return pinsFromMaps({ openai: o?.value, claude: c?.value });
  }

  async function writePins(before, after) {
    const [b, a] = [mapsFromPins(before), mapsFromPins(after)];
    for (const route of Object.keys(MAP_NAMES)) {
      if (a[route] !== b[route]) await arm.setNamedValue(MAP_NAMES[route], a[route], { secret: false });
    }
  }

  /** Ready deployments a product key can be granted: the POC routes pass `model` to Foundry as-is. */
  async function grantableDeployments() {
    return (await catalogue()).filter((e) => e.ready && e.route)
      .map((e) => ({ deployment: e.deployment, model: e.model, version: e.version, route: e.route }))
      .sort((a, b) => a.deployment.localeCompare(b.deployment));
  }

  async function listModels(actor) {
    requireAdmin(actor);
    const [cat, pins] = await Promise.all([catalogue(), currentPins()]);
    return { deployments: describeDeployments(cat, pins), pins };
  }

  async function pinModel(actor, body) {
    requireAdmin(actor);
    const [cat, pins] = await Promise.all([catalogue(), currentPins()]);
    const next = await guard(async () => applyPin(pins, cat, body ?? {}));
    await writePins(pins, next);
    const route = Object.keys(next).find((r) => next[r].length > pins[r].length);
    const added = next[route].at(-1);
    audit(actor, "pin-model", { alias: added.alias, deployment: added.deployment, route });
    return { pins: next };
  }

  async function unpinModel(actor, body) {
    requireAdmin(actor);
    const pins = await currentPins();
    const next = await guard(async () => applyUnpin(pins, body ?? {}));
    await writePins(pins, next);
    audit(actor, "unpin-model", { alias: String(body.alias).toLowerCase(), route: body.route });
    return { pins: next };
  }

  return { listModels, pinModel, unpinModel, grantableDeployments };
}

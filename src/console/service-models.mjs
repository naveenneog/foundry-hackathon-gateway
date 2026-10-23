/** Console service: Foundry deployments and model pinning (P49). Composed into createService. */

import { buildCatalogue } from "../foundry.mjs";
import { pinsFromMaps, mapsFromPins, applyPin, applyUnpin, describeDeployments } from "./pinning.mjs";

export const MAP_NAMES = { openai: "hackgw-model-map", claude: "hackgw-claude-model-map" };

export function modelsApi({ arm, connections, requireAdmin, audit, guard }) {
  async function catalogue(foundryId) {
    const account = await connections.getAccount(foundryId);
    return account ? buildCatalogue([account]) : [];
  }

  async function currentPins(connection) {
    if (!connection.connected) return { openai: [], claude: [] };
    const [o, c] = await Promise.all([arm.getNamedValue(connection.mapNames.openai), arm.getNamedValue(connection.mapNames.claude)]);
    return pinsFromMaps({ openai: o?.value, claude: c?.value });
  }

  async function writePins(before, after, connection) {
    const [b, a] = [mapsFromPins(before), mapsFromPins(after)];
    for (const route of Object.keys(MAP_NAMES)) {
      if (a[route] !== b[route]) await arm.setNamedValue(connection.mapNames[route], a[route], { secret: false });
    }
  }

  /** Ready deployments a product key can be granted: the POC routes pass `model` to Foundry as-is. */
  async function grantableDeployments(foundryId) {
    return (await catalogue(foundryId)).filter((e) => e.ready && e.route)
      .map((e) => ({ deployment: e.deployment, model: e.model, version: e.version, route: e.route }))
      .sort((a, b) => a.deployment.localeCompare(b.deployment));
  }

  async function listModels(actor, { foundryId } = {}) {
    requireAdmin(actor);
    const connection = await connections.connectionFor(foundryId, { allowUnattached: true });
    const [cat, pins] = await Promise.all([catalogue(foundryId), currentPins(connection)]);
    return { deployments: describeDeployments(cat, pins), pins, foundryId: connection.foundryId,
      foundryName: connection.name, connectionId: connection.id, connected: connection.connected,
      setupCommand: connection.foundryId ? connections.setupCommand(connection.foundryId) : null };
  }

  async function pinModel(actor, body) {
    requireAdmin(actor);
    const connection = await connections.connectionFor(body?.foundryId);
    const [cat, pins] = await Promise.all([catalogue(body?.foundryId), currentPins(connection)]);
    const next = await guard(async () => applyPin(pins, cat, body ?? {}));
    await writePins(pins, next, connection);
    const route = Object.keys(next).find((r) => next[r].length > pins[r].length);
    const added = next[route].at(-1);
    audit(actor, "pin-model", { alias: added.alias, deployment: added.deployment, route, foundryId: connection.foundryId });
    return { pins: next };
  }

  async function unpinModel(actor, body) {
    requireAdmin(actor);
    const connection = await connections.connectionFor(body?.foundryId);
    const pins = await currentPins(connection);
    const next = await guard(async () => applyUnpin(pins, body ?? {}));
    await writePins(pins, next, connection);
    audit(actor, "unpin-model", { alias: String(body.alias).toLowerCase(), route: body.route });
    return { pins: next };
  }

  return { listModels, pinModel, unpinModel, grantableDeployments };
}

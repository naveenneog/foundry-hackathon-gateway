/**
 * Client configuration snippets, mirroring scripts/Keys.ps1 Write-Handout (signed keys) and
 * poc/products-keyvault/SETUP.md (product keys).
 */

const trim = (url) => String(url).replace(/\/+$/, "");

export function jwtHandout({ gatewayUrl, token, models, claudeModels = [] }) {
  const gw = trim(gatewayUrl);
  const claude = models.filter((m) => claudeModels.includes(m));
  const openai = models.filter((m) => !claudeModels.includes(m));
  const env = { OPENAI_BASE_URL: `${gw}/v1`, OPENAI_API_KEY: token };
  const opencode = openai.length ? {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "hackathon-gateway": {
        npm: "@ai-sdk/openai-compatible",
        name: "Hackathon Gateway (Foundry)",
        // A custom-named provider does not fall back to OPENAI_API_KEY; see Keys.ps1.
        options: { baseURL: `${gw}/v1`, apiKey: "{env:OPENAI_API_KEY}" },
        models: Object.fromEntries(openai.map((m) => [m, { name: m }])),
      },
    },
    model: `hackathon-gateway/${openai[0]}`,
  } : null;
  // AUTH_TOKEN, not API_KEY: the gateway validates `Authorization: Bearer`.
  const claudeSettings = claude.length ? {
    env: { ANTHROPIC_BASE_URL: `${gw}/claude`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: claude[0] },
  } : null;
  return { env, opencode, claudeSettings };
}

export function productHandout({ gatewayUrl, key, claudeModel = "claude-haiku-4-5" }) {
  const gw = trim(gatewayUrl);
  return {
    env: { POC_GATEWAY: gw, POC_KEY: key },
    // The POC Claude route reads the subscription key from x-api-key, which ANTHROPIC_API_KEY sends.
    claudeSettings: {
      env: { ANTHROPIC_BASE_URL: `${gw}/poc/claude`, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: claudeModel },
    },
    curl: `curl -sS "${gw}/poc/v1/chat/completions" -H "api-key: ${key}" -H "content-type: application/json" ` +
      `-d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'`,
  };
}

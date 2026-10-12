// A model through the gateway's OpenAI-compatible route, with the OpenAI SDK for Node.js.
//
// The route reads the subscription key from the api-key header, added here as a default header.
// The SDK also requires apiKey and sends it as Authorization: Bearer; the gateway replaces that
// header with its own credential before it calls Foundry, so any value works. Run by
// scripts/Test-PocClients.ps1; see SETUP.md.
//
// Environment: POC_GATEWAY (https://<apim-name>.azure-api.net) and POC_KEY (a key issued on a
// product whose pack includes the model below).
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${process.env.POC_GATEWAY}/poc/v1`,
  apiKey: "not-used",
  defaultHeaders: { "api-key": process.env.POC_KEY },
});

const response = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});
console.log(response.choices[0].message.content);

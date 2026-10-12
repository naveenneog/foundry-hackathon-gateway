"""A model through the gateway's OpenAI-compatible route, with the OpenAI SDK for Python.

The route reads the subscription key from the api-key header, added here as a default header.
The SDK also requires api_key and sends it as Authorization: Bearer; the gateway replaces that
header with its own credential before it calls Foundry, so any value works. Run by
scripts/Test-PocClients.ps1; see SETUP.md.

Environment:
    POC_GATEWAY  https://<apim-name>.azure-api.net
    POC_KEY      a key issued on a product whose pack includes the model below
"""
import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ["POC_GATEWAY"] + "/poc/v1",
    api_key="not-used",
    default_headers={"api-key": os.environ["POC_KEY"]},
)
response = client.chat.completions.create(
    model="deepseek-v4-flash",
    max_tokens=64,
    messages=[{"role": "user", "content": "Reply with exactly: OK"}],
)
print(response.choices[0].message.content)

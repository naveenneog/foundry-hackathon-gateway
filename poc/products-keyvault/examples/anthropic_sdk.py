"""A Claude model through the gateway's Claude route, with the Anthropic SDK for Python.

The SDK sends its api_key in the x-api-key header, which is where the route reads the
subscription key. Run by scripts/Test-PocClients.ps1; see SETUP.md.

Environment:
    POC_GATEWAY  https://<apim-name>.azure-api.net
    POC_KEY      a key issued on a product whose pack includes the model below
"""
import os

import anthropic

client = anthropic.Anthropic(
    base_url=os.environ["POC_GATEWAY"] + "/poc/claude",
    api_key=os.environ["POC_KEY"],
)
message = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=16,
    messages=[{"role": "user", "content": "Reply with exactly: OK"}],
)
print(message.content[0].text)

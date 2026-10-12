# Claude Code through the gateway's Claude route, with the key in an environment variable, for
# PowerShell. Reads POC_GATEWAY and POC_KEY; claude is started afterwards in the same session.
# Run by scripts/Test-PocClients.ps1; see SETUP.md.
$env:ANTHROPIC_BASE_URL = "$env:POC_GATEWAY/poc/claude"
$env:ANTHROPIC_API_KEY = $env:POC_KEY
$env:ANTHROPIC_MODEL = 'claude-haiku-4-5'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5'
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'

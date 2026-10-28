# Windows twin of scripts/claude-local.sh: launch Claude Code against the LOCAL
# M365 proxy, with an isolated config dir (./.claude-local).
#
#   .\scripts\claude-local.ps1
#   $env:MODEL = "claude-sonnet"; .\scripts\claude-local.ps1
#   .\scripts\claude-local.ps1 -p "write hi"
#
# Env: PORT (4141), MODEL (gpt-5.5-think-deeper), TOOLS (Bash,Read,Edit,Write,Glob,Grep;
# set to "" for all tools), M365_PROXY_API_KEY (if the proxy has one),
# CLAUDE_GUARD ("0" disables the Anthropic egress guard, scripts/claude-guard.mjs).
$port  = if ($env:PORT)  { $env:PORT }  else { "4141" }
$model = if ($env:MODEL) { $env:MODEL } else { "gpt-5.5-think-deeper" }
$tools = if ($null -ne $env:TOOLS) { $env:TOOLS } else { "Bash,Read,Edit,Write,Glob,Grep" }
$root  = Split-Path -Parent $PSScriptRoot

try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/health" | Out-Null }
catch { Write-Host "[claude-local] no proxy answering on :$port - start it with 'pnpm run proxy' (or set PORT)" }

# Set for this process only; the child inherits them, the shell keeps its own.
$env:CLAUDE_CONFIG_DIR = Join-Path $root ".claude-local"
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
$env:ANTHROPIC_AUTH_TOKEN = if ($env:M365_PROXY_API_KEY) { $env:M365_PROXY_API_KEY } else { "m365" }
Remove-Item Env:ANTHROPIC_API_KEY, Env:CLAUDE_CODE_USE_BEDROCK, Env:CLAUDE_CODE_USE_VERTEX -ErrorAction SilentlyContinue
foreach ($v in "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL") {
  Set-Item "Env:$v" $model
}
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

$claudeArgs = @("--model", $model)
if ($tools) { $claudeArgs += "--tools=$tools" }
Write-Host "[claude-local] proxy=$($env:ANTHROPIC_BASE_URL)  model=$model  tools=$(if ($tools) { $tools } else { 'all' })  config=$($env:CLAUDE_CONFIG_DIR)"
# Egress guard: Anthropic hosts are refused and the first attempt kills Claude Code
# (scripts/claude-guard.mjs). $env:CLAUDE_GUARD = "0" runs claude without it.
if ($env:CLAUDE_GUARD -eq "0") { & claude @claudeArgs @args }
else { & node (Join-Path $PSScriptRoot "claude-guard.mjs") claude @claudeArgs @args }
exit $LASTEXITCODE

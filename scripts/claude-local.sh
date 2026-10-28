#!/usr/bin/env bash
# Launch Claude Code pointed at the LOCAL M365 proxy (its /v1/messages endpoint),
# with an isolated, repo-local config dir (./.claude-local) so it never touches
# your real ~/.claude settings, sessions or login.
#
#   pnpm run claude                      # interactive, model gpt-6.1-sol
#   MODEL=claude-sonnet pnpm run claude  # another proxy model
#   PORT=24034 pnpm run claude           # proxy on another port
#   TOOLS= pnpm run claude               # all of Claude Code's tools (see below)
#   pnpm run claude -- -p "write hi"     # pass a prompt / extra flags through
#
# Runs under scripts/claude-guard.mjs: every attempt to reach an Anthropic host is
# refused; Claude Code keeps running. CLAUDE_GUARD=0 turns it off.
#
# Start the proxy first in another shell:  pnpm run proxy   (defaults to :4141)
set -euo pipefail

PORT="${PORT:-4141}"
MODEL="${MODEL:-gpt-6.1-sol}"
# Claude Code's full tool set is large; big tool schemas make M365 Disengage, so
# advertise only the core coding tools unless TOOLS says otherwise.
TOOLS="${TOOLS-Bash,Read,Edit,Write,Glob,Grep}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[claude-local] ⚠ no proxy answering on :${PORT} — start it with 'pnpm run proxy' (or set PORT=...)"
fi

export CLAUDE_CONFIG_DIR="$ROOT/.claude-local"
export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"
# Any non-empty token stops Claude Code asking for a login; it must match
# M365_PROXY_API_KEY when the proxy has one.
export ANTHROPIC_AUTH_TOKEN="${M365_PROXY_API_KEY:-m365}"
unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
# Every Claude Code model slot (incl. the haiku one for background work) → MODEL.
export ANTHROPIC_MODEL="$MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL" ANTHROPIC_SMALL_FAST_MODEL="$MODEL"
# No telemetry/update/error-report traffic to Anthropic from this session, and no
# automatic download of Anthropic's plugin marketplace (github.com/anthropics/...).
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
# Compact (summarise old turns) at 60k tokens instead of the assumed 200k: M365 keeps
# only ~85-90k tokens of a conversation in view (docs/hypotheses.md §39). After a
# compaction the proxy starts a fresh M365 conversation with the short history.
# Claude Code raises a window under 100k to 100k, so use the 100k window and compact
# at 60% of it.
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-100000}"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-60}"

# Bash output up to 128k chars inline (Claude Code's max; default 30k). Past that it
# hands the model only a 2KB preview, which M365 models answer by retrying in a loop.
args=(--model "$MODEL" --settings "$ROOT/scripts/claude-local.settings.json")
[[ -n "$TOOLS" ]] && args+=("--tools=$TOOLS")
echo "[claude-local] proxy=$ANTHROPIC_BASE_URL  model=$MODEL  tools=${TOOLS:-all}  config=$CLAUDE_CONFIG_DIR"
# Egress guard: Anthropic hosts are refused (nothing is sent); Claude Code keeps running
# (scripts/claude-guard.mjs). CLAUDE_GUARD=0 runs claude without it.
if [[ "${CLAUDE_GUARD:-1}" == "0" ]]; then
  exec claude "${args[@]}" "$@"
fi
exec node "$ROOT/scripts/claude-guard.mjs" claude "${args[@]}" "$@"

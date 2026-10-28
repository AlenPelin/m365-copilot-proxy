# m365-copilot-proxy

## Start here (new users)

### What this project does

Your work account may come with Microsoft 365 Copilot. It can talk to strong models
(GPT-5.x, GPT-6, Claude Sonnet/Opus), but only through Microsoft's chat window. Coding
agents such as pi, OpenClaw and Claude Code can't use it, because they expect an OpenAI or
Anthropic API.

This project is a small local server (the **proxy**) that sits in between:

```
coding agent  ──HTTP──▶  proxy on 127.0.0.1:4141  ──WebSocket──▶  M365 Copilot (Microsoft)
(Claude Code)       translates both ways                      signed in as you
```

- It signs in to M365 Copilot as you, the same way the Copilot web page does.
- It offers `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic) on your machine.
- M365 Copilot has no real tool calling, so the proxy describes the tools in the prompt,
  reads the tool calls back out of the model's text, and hands them to the agent. The agent
  then runs them (edit a file, run a command) on your machine.

You get a working coding agent that uses the Copilot seat you already have, with no
separate OpenAI or Anthropic bill.

### How to use it (quick start)

1. **Check you can use it.** You need a work or school (Entra ID) account with M365
   Copilot Chat, Node.js 24+ and pnpm 10+. Personal Microsoft accounts don't work.
2. **Install:** `git clone`, `pnpm install`, `pnpm build` ([details](#1-install)).
3. **Start the proxy and sign in:** `pnpm run proxy`. The first time, a browser window
   opens and you sign in yourself, with your usual MFA. The proxy never stores your
   password. After that, cached tokens are refreshed silently ([details](#2-sign-in)).
4. The proxy listens on `http://127.0.0.1:4141`.
6. **Pick a model** with `$env:MODEL = "gpt-6.1-sol"` (see [Available models](#available-models)). What you
   can use depends on your Copilot licence: some models need a premium seat, and some have
   daily or weekly quotas.
5. **Start an agent** in another shell:
   - Claude Code: `copilot`, or `.\scripts\claude-local.ps1` on Windows
     ([details](#4-use-with-claude-code))
   - anything else OpenAI-compatible: base URL `http://127.0.0.1:4141/v1`, any API key
     ([details](#6-use-as-standalone-proxy))
     
Expect it to be slower than a real API (10–30 s per reply on the thinking models), and keep
the agent's tool set small: big tool lists make M365 refuse to answer (`Disengaged`).

> **Want the gory protocol details?** See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) — a full write-up of M365 Copilot's undocumented WebSocket API: auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that makes tool calling work.

### How it protects your data

What it does:

- **Data goes only to Microsoft.** The proxy has no telemetry, analytics or third-party
  hosts. It sends your prompts to the same M365 Copilot service your company already uses,
  under your company's Microsoft agreement. The full list of hosts is in
  [Data flow and privacy](#data-flow-and-privacy).
- **Nothing is open to the network.** The server binds to `127.0.0.1` only. You can add a
  key with `M365_PROXY_API_KEY`.
- **No chat history.** Proxy chats use M365 temporary-chat mode, so they don't show up in
  your Copilot history (unless `M365_SAVE_HISTORY=1`).
- **Claude Code can't reach Anthropic.** The `claude-local` launcher uses its own config
  folder, turns off Claude Code's telemetry and update traffic, and runs Claude Code behind
  an **egress guard**. The guard refuses every connection to `anthropic.com`, `claude.ai`
  and `claude.com` before anything is sent, including connections from commands the agent
  runs ([details](#4-use-with-claude-code)).
- **No logs of your prompts by default.** Prompt and reply dumps are written only when you
  turn on `M365_DEBUG`, `M365_TRACE` or `M365_DUMP_FRAMES`.

What it does **not** do — read this before using it on client work:

- **Everything the agent reads goes to Microsoft.** File contents, command output and paths
  are all part of the prompt. If a client contract says their code must not be sent to an
  AI service, this tool breaks that rule, the same as pasting the code into Copilot by hand
  would.
- **Your tenant admins can see your use.** The proxy creates nothing in your tenant, but
  sign-ins and Copilot use are logged by Microsoft for your organisation as usual.
- **The token cache is a key to your account.** `msal-cache.json` holds a refresh token
  (owner-only on Linux/macOS). Anyone who copies it can use Copilot as you until it
  expires. No password or MFA secret is stored.
- **The egress guard only covers programs that honour proxy settings.** Only an OS firewall
  rule stops a program that ignores them.
- **Nothing stops you leaking data into this repo.** If you copy a real model reply into a
  test or a doc, scrub client names, paths and file names first.

### Is it legal to use with Microsoft 365 Copilot?

Short answer: **it is not an approved way to use M365 Copilot, and it can break your
company's rules or Microsoft's terms. Check before you use it at work.** This is not legal
advice.

- **There is no official API.** Microsoft does not offer M365 Copilot chat as an API for
  third-party tools. This proxy uses the private API behind Microsoft's own web client.
- **It pretends to be Microsoft's client.** It signs in with Microsoft's own first-party
  client ID, sends the same headers as the web page, and opens the sign-in page in
  a browser set up to hide that it is automated. Microsoft's terms generally don't allow
  accessing services by automated or unapproved means. Microsoft could block it at any
  time, and could act against the account.
- **Your company's policy comes first.** M365 is licensed to your employer, not to you.
  Most companies have an acceptable-use or AI-use policy, and many limit which tools may
  send company or client data to an AI service. Using this without approval could be a
  policy breach even though the data stays with Microsoft.
- **Client contracts matter too.** If you work for a client, their contract may forbid AI
  tools on their code, or allow only some of them.
- **What's on your side:** your data goes only to Microsoft, under the agreement your
  company already has, and only through your own account and licence. The proxy does not
  share your seat or get around licence limits or quotas.

Safest path: ask your IT or security team first and tell them exactly what it does (this
section and [Data flow and privacy](#data-flow-and-privacy) are written for that). Use it
for work only if they say yes. If you're unsure, use it only on your own code. The
[MIT licence](LICENSE) gives no warranty: you use it at your own risk.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **Standalone proxy** — HTTP server with `/v1/chat/completions` and `/v1/models` endpoints. Works with any OpenAI-compatible client (pi, OpenClaw, etc.). It also serves the Anthropic Messages API (`/v1/messages`, `/v1/messages/count_tokens`) for Claude Code — see [Use with Claude Code](#4-use-with-claude-code).
2. **OpenClaw plugin** — Config generator + setup CLI for OpenClaw's provider system.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead, tools are
emulated via a **Markdown-fence format** (the JSON `{"tool":...}` format was removed —
it scored 0/5 on real agentic tasks; see [hypotheses §9](docs/hypotheses.md)):

- Tool definitions are injected into the prompt as fenced templates inside a `<tools>` block
- The model emits a fenced tool call — a code block whose info-string is the tool name
  (scalar args as `key: value` header lines, one free-form body arg as the fence body,
  `old`/`new` edits as aider-style `SEARCH/REPLACE` diffs)
- The proxy/handler parses that and converts it to OpenAI `tool_calls` format
- **Tool results go back as `<tool_response>` blocks** (`formatToolResponse` in
  `core/src/tools.ts`, used on the first turn and on every follow-up turn): the block names the
  tool and the argument that identifies the call, found through the result's `tool_call_id`:
  `<tool_response tool="bash" command="ls -la">`. The attribute is `command` for
  `command`/`cmd`/`script`, `path` for `path`/`file_path` (Claude Code's Read/Edit)/`filePath`/
  `file`/`filename`, `query` for `query`, otherwise `input` (the first string argument). Newlines
  become spaces, `\` and `"` are escaped (not swapped for `'`: `"$f"` and `'$f'` are different
  shell commands), and a value over 100 chars is cut and ends in `…`, so the model doesn't read
  the label as its own command cut short. A result whose call can't be found is labelled
  `tool="tool"` with no attribute (upstream PR #70: GPT-5.6 called a file edit labelled
  `command="todo.mjs"` "an unexpected label", and gave up on a silently cut one).
- **Fence shapes the parser reads** (`scanFences` in `core/src/fenced.ts`, CommonMark rules;
  upstream PR #71): backtick or `~~~` fences; 4+ backtick fences (the closer must be at least as
  long as the opener, and a same-length opener inside an open block nests); an indented fence
  (the body loses the opener's indentation); extra info-string words like `title="x"` (only the
  first word names the tool); tool names matched ignoring case when exactly one tool fits
  (```` ```Bash ````). Fallback closers, used only when nothing else closes the block: a closer
  glued to the last line, and a closer with prose glued on (```` ```Then run… ````, 3+ words, no
  `=` or `{`). No fallback closer is taken while a heredoc in the body (`<<EOF`, `<<'EOF'`,
  `<<-EOF`) is still open, so a cut-off heredoc never runs and clobbers a file. A fence line that
  reads as prose (```` ```Here is the plan ````) is not an opener unless its first word is a tool name.
- **Argument values follow the tool's JSON schema** (`coerceHeaderValue` / `parseFencedInner`
  in `fenced.ts`). Every value arrives as text and is converted to the declared type: `boolean`
  (`true`/`yes`/`y`/`1`/`on` and the false forms, any case), `integer` / `number` (whole-string
  parse), `array` (JSON, or one plain value as a one-item list, empty as `[]`), `object` (JSON,
  empty as `{}`). This applies to header lines and to the fence body when the body param is not
  a string (a tool whose one param is a boolean, number, array or object); a string body keeps
  its text exactly, whitespace included. A value that doesn't convert stays the original string,
  so the harness rejects it loudly (`offset: the whole file` stays text, never `null`). One
  exception, fail closed: an `array` value that starts with `[` but isn't JSON, or an `object`
  value that isn't a JSON object (a reply cut off mid-value, `edits: [{"oldText":"a",`), drops
  the whole call. The fence then counts as unreadable and the model is asked again (next item),
  instead of the harness getting a value of the wrong shape that passes its required-param
  check (port of ghostinator def9700).
- **Asking again for an unreadable call** (`unreadableToolFence` in `fenced.ts`,
  `unreadableToolCall` in `tools.ts`): when a tool turn has no call, and the sandbox re-route
  (below) found nothing, but the reply held a tool fence that couldn't be read (never closed, an
  edit fence without its SEARCH/REPLACE markers, or a reply that is only a one-line
  ```` ```bash ls``` ````), the handler sends one follow-up in the same conversation naming the
  problem and asking to resend it as one block, or to reply without it. The forcing (confab)
  retry is skipped after that re-ask. Costs one upstream turn. `M365_NO_FENCE_RETRY=1` turns it off.
- **Give-up phrasings** (`CONFABULATION_PATTERNS` in `core/src/tools.ts`, read by
  `looksLikeConfabulation`): a tool turn with no call whose text matches one of these gets the
  forcing retry (see `M365_NO_CONFAB_RETRY`). Besides "can't access / run / read …", "don't have
  access", "paste the contents", the `/mnt/data` sandbox tells and the Turkish forms, it catches
  first-person "I can't / I'm unable to / I'm not able to **generate, produce, export, create or
  make** files, documents or PDFs" and "I can't … **in the current session / this chat / this
  conversation**" (upstream PR #78). Both need the "I": a finished answer about what a program
  can't do ("the exporter can't generate PDFs without wkhtmltopdf") is not a give-up.
  From upstream PR #70: "no (up to four words) tool(s) is/are **available, accessible or
  enabled**" ("no execution tool is enabled in this turn"); "tools aren't / isn't / are not
  enabled **in this / for this / here / to me / for me**" ("file tools aren't enabled in this
  chat"; "tools are not enabled for requests without a tools array" stays prose); and "I
  wasn't able to / couldn't **complete or finish** … **in this run / session / turn / chat /
  conversation / environment** or … **the / this / your task or request**". That last one
  needs the whole run or task: "I couldn't complete the integration tests because they need
  Docker" is an honest partial report, not a give-up.
- **Shell-routing (the key lever):** M365's chat-tuned model won't "act as an agent" on
  demand but *will* reflexively write a ```` ```bash ```` block. When the toolset includes a
  shell tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the
  whole step by writing one ```` ```bash ```` block" framing and routes that block to the
  shell tool. This exploits the one agentic behavior Microsoft's system prompt permits, and
  is what turns 0/5 into real multi-turn loops (verified 9-tool-call bug fix).
- **Reliability comes from the fenced/shell framing** (`relay`, `relay_batch`, `baseline`;
  see [Available models](#available-models) for which model gets which).

### No Copilot Studio agent (removed 2026-10-28)

Earlier versions created a **Copilot Studio agent** (a `minimalBots` bot, named
`m365-tool-agent-<hash>`) in your tenant's default Power Platform environment, published
it, and attached it to tool requests (`threadLevelGptId`) to put tool-calling instructions
in its server-side system prompt. That is gone completely: the proxy no longer asks for
Power Platform/BAP tokens, never calls `api.bap.microsoft.com` or
`*.environment.api.powerplatform.com`, and creates nothing in your tenant. Every request is
a plain chat request, the same as the Copilot web page sends. `M365_FORCE_AGENT` is
ignored, and `~/.config/opencode-m365/agent-id.json` is no longer read (delete it).

Why: basic accounts can't publish it at all (403 *"Publishing this agent requires
Copilot extensibility"*), every attempt created or deleted bots your admins can see, and
the launcher already defaulted to running without it. Model notes below that compare
"with the agent" and "agent-less" are bench history; agent-less is the only path now.

**Bots left over from older versions** stay in your tenant until you delete them. Open
<https://copilotstudio.microsoft.com>, pick your default environment, open **Agents**,
and delete any `m365-tool-agent-*`.

### M365 markup in answers

The models write markup that only M365's web client renders. `stripM365Markup`
(`proxy-lib/src/markup.ts`) cleans a text answer of it, on the OpenAI path for every text reply
to a tool request (`handler.ts`; the tool-less path streams deltas live and is passed through as
M365 wrote it) and on the Anthropic path for every text block:

- Citation markers (`U+E200 cite U+E202 <ref> U+E201`, shown as "citeturn0file1") are removed
  everywhere (private-use characters, never real content).
- File chips become the bare file name: `<File>notlar.docx</File>` → `notlar.docx`. Tag names
  `file`, `files`, `document`, any case, spaces allowed inside the brackets (`< File>`); the name
  is 1–200 chars with no `<`, `>` or newline, and the closing tag must match. A lone `<stdio.h>`
  is not touched. Upstream PR #70 counted `<File>` in 58 of 245 distinct final pi answers.
- Fenced code blocks and inline code (`` `<File>a.txt</File>` ``) are left as they are.
- Outside code, spaces at line ends (left by a removed marker) are trimmed.

Tool-call inputs are never cleaned: a command or file body may legitimately contain `<File>`
(WiX XML).

### Conversation reuse

Each agent session reuses the same M365 conversation (same `sessionId` + `conversationId`). The WebSocket reconnects per turn but M365 maintains server-side context. This saves quota — the 600 message limit applies per-conversation.

### Assembling a turn's text

One M365 turn can hold several bot messages. `TurnTextComposer` (`core/src/session.ts`) keeps
text per message: a `cursor` frame names the message that the following token deltas extend, a
full-text snapshot replaces (folds into) its message's text, and the turn's text is the
non-empty messages joined by a blank line. One special case (upstream PR #70): when a message
opens with `<`, M365 sends the head snapshot `<` and then a first delta that starts with `<` again
(`<document`), because it holds the `<` back until it knows the tag. That first delta replaces the
`<` instead of being appended, so the reply doesn't start `<<document>`. Only a lone `<` head
counts: `*` + `*Summary**` or `` ` `` + ` ``bash` are continuations and are appended.

## Packages

```
@m365-copilot/core          — Shared: auth, WebSocket client, tool formatting, proxy server, session
├── @m365-copilot/proxy     — Standalone HTTP proxy binary
└── @m365-copilot/openclaw-plugin  — OpenClaw config generator + setup CLI + skill
```

## Setup

### Prerequisites

- Node.js 24+
- pnpm 10+
- A **work or school (Entra ID) account** with M365 Copilot Chat. Personal Microsoft
  accounts — Microsoft 365 Personal/Family, Outlook.com, copilot.microsoft.com — are
  not supported: the proxy talks to the enterprise M365 Copilot service, and the Office
  client it signs in as rejects personal accounts ("You can't sign in here with a
  personal account", #64). "Every account" elsewhere in this README means every work
  or school account, premium or not.
- **A display, once.** Sign-in is interactive only: a browser window opens and you sign
  in yourself, with whatever MFA your tenant enforces. After that tokens refresh
  silently. A headless host (systemd, CI) needs a cache copied from a machine where you
  signed in (see [Sign in](#2-sign-in)).

### 1. Install

```sh
git clone https://github.com/cramt/m365-copilot-proxy
cd m365-copilot-proxy
pnpm install
pnpm build
```

### 2. Sign in

Sign-in is **interactive only**. There is no config file: the proxy never stores your
password or an MFA secret. Start the proxy on a machine with a display:

```sh
pnpm run proxy
```

On first start (or when the cached refresh token has expired) a real browser window
opens. Complete SSO/MFA by hand exactly as you would in Outlook — TOTP, push, FIDO2,
Windows Hello, Okta/Ping/Duo, whatever your tenant enforces. The proxy captures the
resulting OAuth code and from then on refreshes tokens silently from
`~/.config/opencode-m365/msal-cache.json`, so the window is a **one-time cost**, not a
per-run prompt. The console shows `[m365 auth] Waiting up to 600s.` while you sign in,
then `[m365 auth] Signed in as <you> — token saved, browser closing.` and, once the
server is up, `Listening on http://127.0.0.1:4141`. `M365_INTERACTIVE_TIMEOUT_MS`
changes the 600 s wait.

**Headless hosts** (systemd, CI, a server): set `M365_NO_INTERACTIVE=1` so a missing or
expired token fails loudly instead of waiting on a window nobody can see. Sign in once
on a desktop machine, then copy its `msal-cache.json` to the host's
`~/.config/opencode-m365/` (or point `M365_CACHE_FILE` at it). Treat that file like a
password: it holds a refresh token for your account.

**Old `secrets.json`:** the stored-credentials login (email + password + TOTP secret,
typed into a headless browser) was removed on 2026-10-28. If
`~/.config/opencode-m365/secrets.json` (or `M365_SECRETS_FILE`) still exists, the proxy
ignores it and prints a one-line warning to delete it, because it holds your password
in plain text. `M365_ENABLE_INTERACTIVE_APPROVAL` is no longer needed; it is ignored.
Research scripts under `scripts/` that imported `loadSecrets`/`loginAutomated` from
core no longer run.

The interactive path was contributed by [@EatonWu](https://github.com/EatonWu). Nobody
has yet run it end to end against a federated Okta/Ping/Duo tenant. If that's you,
please report in [#4](https://github.com/cramt/m365-copilot-proxy/issues/4) — working
or not.

> **Not device code.** The obvious headless alternative — `login.microsoft.com/device`
> with a short code — is permanently dead here, not merely unimplemented. Initiation
> returns a valid code, but redeeming it fails with `AADSTS7000218`: Entra treats
> Microsoft's own Copilot client as confidential for that grant and demands a
> `client_secret` only Microsoft holds. No tenant admin can grant it. Measured, with the
> sign-in actually completed, in [§13 H13.2](docs/hypotheses.md).

### 3. Use with pi (or any OpenAI-compatible agent)

Start the proxy:

```sh
m365-proxy 4143        # or: pnpm run proxy 4143
```

Point [pi](https://pi.dev/) at it via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "m365": {
      "baseUrl": "http://localhost:4143/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        { "id": "gpt-6.1-sol", "name": "M365 Copilot (GPT-6.1 Sol, recommended)" },
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5)" },
        { "id": "m365-copilot", "name": "M365 Copilot (Auto)" }
      ]
    }
  }
}
```

> `apiKey` is a placeholder. The proxy binds to `127.0.0.1` and checks no credential
> unless `M365_PROXY_API_KEY` is set (then `apiKey` must be that key) — the field exists
> only because the OpenAI client schema requires it.

To let the model see images — a screenshot, a chart the agent drew, a PNG it `read`s — add
`"input": ["text", "image"]` to each model entry. pi then sends them as `image_url` parts and the proxy
uploads them to M365 the way the web client does.

Then run pi (use `gpt-6.1-sol` — the default and recommended tool-calling model — and keep the
toolset lean; M365 "disengages" on very large tool payloads, see
[docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter)):

```sh
pi --models "gpt-6.1-sol" -p --tools read,list,edit,write "your task"
```

This is verified working end-to-end, including multi-tool calls and real file edits.

**Long sessions.** Every turn draws on the account's throttle budget, about 100 turns refilled at
~1.6 a minute. A busy pi session can run it dry, and M365 then refuses every turn for about an hour
(`PerUserThrottled`). Start the proxy with `M365_AVOID_THROTTLING=1` (and `M365_DEBUG=1`, so it can
read the budget from its logs) and it slows the session down instead. Once the budget is down to a
reserve, it waits before each turn, inside the open stream so pi doesn't time out. See
[`M365_AVOID_THROTTLING`](#environment-variables).

### 4. Use with Claude Code

The proxy also speaks the Anthropic Messages API, so Claude Code can use it. Start the
proxy, then in another shell:

```sh
pnpm run claude                         # bash (Linux/macOS/Git Bash)
.\scripts\claude-local.ps1              # Windows PowerShell
MODEL=claude-sonnet pnpm run claude     # another proxy model
pnpm run claude -- -p "write hi"        # extra Claude Code flags pass through
```

**A `copilot` command (Windows, optional).** To start it from any folder, put two small
launchers in a folder on your `PATH` (here `%USERPROFILE%\.local\bin`, which the Claude
Code installer already adds). They are not part of the repo; change the path if your clone
lives elsewhere.

`copilot.cmd` (PowerShell and cmd):

```bat
@echo off
rem Launch Claude Code against the local M365 proxy (C:\alen\claude-copilot).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\alen\claude-copilot\scripts\claude-local.ps1" %*
exit /b %ERRORLEVEL%
```

`copilot`, no extension (Git Bash):

```sh
#!/bin/sh
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/alen/claude-copilot/scripts/claude-local.ps1" "$@"
```

Then `copilot`, `copilot -p "write hi"` or `$env:MODEL="claude-sonnet"; copilot` works
anywhere. Claude Code runs in the current folder, and its config still comes from the
repo's `.claude-local`. The launcher runs in its own `powershell.exe`, so the `ANTHROPIC_*`
variables it sets don't stay in your shell (running `.\scripts\claude-local.ps1` directly
does leave them set in that PowerShell session). The proxy must already be running.

The launcher (`scripts/claude-local.sh`, Windows twin `scripts/claude-local.ps1`) runs
`claude` with:

| Setting | Value | Why |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `./.claude-local` | isolated config; your real `~/.claude` login/settings are untouched |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:$PORT` (`PORT` default `4141`) | the local proxy |
| `ANTHROPIC_AUTH_TOKEN` | `$M365_PROXY_API_KEY`, else `m365` | any non-empty token skips Claude Code's login; must match the proxy key when one is set |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` | `$MODEL` (default `gpt-6.1-sol`) | every model slot, background haiku calls included, goes to one proxy model |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | no telemetry/update traffic to Anthropic |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | `1` | Claude Code does not download Anthropic's plugin marketplace (`github.com/anthropics/claude-plugins-official`, ~23 MB) into `.claude-local`. The guard can't block that by itself: it only sees the host, `github.com`, which the agent's own `git` needs |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` + `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `100000` + `60` (keeps yours if set) | Claude Code summarises old turns at 60k tokens (60% of a 100k window) instead of the 200k it assumes for an unknown model. Claude Code raises any window under 100k to 100k and warns, so the window alone can't go lower; it compacts at `min(window × pct%, window − 13k)`, which is 87k without the percent. M365 keeps only about the last 85–90k tokens of a conversation in view: GPT-6.1 Sol lost a planted rule, facts and its tool instructions past that (`docs/hypotheses.md` §39). After a compaction the proxy starts a fresh M365 conversation with the short history |
| `--settings` | `scripts/claude-local.settings.json`: `bashOutputMaxChars: 128000` | Bash output up to 128k characters goes to the model inline (Claude Code's maximum; default 30k). Past that, Claude Code saves it to a file and sends only a 2 KB preview, and M365 models answered that by retrying near-identical commands in a loop (seen: 14 turns, `find`/`sed` walking .NET `bin/` and `obj/`). A file, not inline JSON, because PowerShell 5.1 mangles quotes in native-command arguments |
| `--tools` | `$TOOLS` (default `Bash,Read,Edit,Write,Glob,Grep`; `TOOLS=` for all) | Claude Code's full tool set is large, and big tool schemas make M365 `Disengage` |

It unsets `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`.

**Egress guard** (`scripts/claude-guard.mjs`, on by default; `CLAUDE_GUARD=0` turns it
off). The launcher runs `claude` as `node scripts/claude-guard.mjs claude …`. The guard
starts a local HTTP(S) proxy on a random `127.0.0.1` port and runs Claude Code with
`HTTPS_PROXY`/`HTTP_PROXY` (both cases) pointing at it. Any inherited proxy variables
are removed, and `NO_PROXY` is set to `127.0.0.1,localhost,::1` only, so the M365 proxy
is reached directly and nothing else is exempt. Then:

- **A connection to a blocked host is refused before any DNS lookup or TCP connect**
  (`403`), so nothing is sent. Every attempt is refused; Claude Code keeps running and
  just sees a failed request. Nothing is printed during the session (it would garble
  Claude Code's screen). When Claude Code exits, the guard prints
  `[claude-guard] blocked connection attempts (nothing was sent): <host> (<n>x), …`.
- Every other host is passed through (CONNECT tunnel or plain-HTTP forward), so tools the
  agent runs from Bash (npm, git, curl — they inherit the proxy variables) keep working.
  A Bash `curl https://api.anthropic.com` is refused too.
- The guard exits with Claude Code's exit code. Ctrl+C goes to Claude Code.

| Env | Default | Meaning |
|---|---|---|
| `CLAUDE_GUARD` | `1` | `0` runs `claude` without the guard |
| `CLAUDE_GUARD_BLOCK` | `anthropic.com,claude.ai,claude.com` | comma-separated domains; each also blocks its subdomains (`api.anthropic.com`), not lookalikes (`notanthropic.com`) |
| `CLAUDE_GUARD_LOG` | unset | file that gets one line per connection: `START`, `ALLOW host:port`, `BLOCKED host:port` |

Tested on Windows with Node 16 and 24: in a normal launcher run nothing was blocked and the
reply came through; Claude Code aimed at the real API had every attempt at
`api.anthropic.com:443` refused. Limit: it relies on programs honouring the proxy variables
(Claude Code and common CLI tools do). A program that ignores them would bypass the
guard; only an OS firewall rule can stop that.
Any other Anthropic client works too: point it at `http://127.0.0.1:4141` (no `/v1`).

**How the endpoint works** (`packages/proxy-lib/src/anthropic.ts`). It is a translation
layer over the OpenAI handler, so every proxy behaviour (session reuse, tool emulation,
retries, throttling) applies unchanged:

- **Request.** `system` (string or text blocks) plus any `role: "system"` messages become
  one system message. `tool_use` blocks become assistant `tool_calls`; each `tool_result`
  becomes a `tool` message (named after its `tool_use`; `is_error` adds a `[tool error]`
  line). Base64 `image` blocks (also inside tool results) become `image_url` data-URL
  parts, which the handler uploads to M365; URL images are a 400 (the proxy never fetches
  a client-supplied URL). Text `document` blocks become text.
  `thinking`/`redacted_thinking` blocks in assistant history are dropped. Any other block
  type is answered with a 400 `invalid_request_error`, never silently dropped.
  `tools` → OpenAI functions; `tool_choice` `auto`/`any`/`none`/`tool` →
  `auto`/`required`/`none`/named function. `cache_control` and other extra fields are ignored.
- **Model.** An exact proxy model ID is used as is; so is `claude-m365--<id>` (prefix
  stripped). Any other name — Claude Code's own `claude-sonnet-4-5-…`, `claude-haiku-…` —
  goes to `M365_CLAUDE_CODE_MODEL` if that is a proxy model, else the chat default
  (`gpt-6.1-sol`). The response's `model` echoes the requested name.
- **Response.** Text and tool calls become `text` and `tool_use` blocks. Text blocks are
  cleaned of M365 web-UI markup (`stripM365Markup`, see
  [M365 markup in answers](#m365-markup-in-answers); the OpenAI path already did it for tool
  requests, and it is idempotent). A one-line code block with no language or `text`/`txt`/`plaintext`
  (GPT models write "around:", ```` ```text line 111``` ````, "for …") becomes inline code,
  joined into the sentence when it follows "…:" and the next line starts lowercase
  (`inlineTinyCodeBlocks`); blocks with a language or several lines are kept. A `tool_result` that Claude Code cut to a preview
  (`<persisted-output>`) gets `PERSISTED_OUTPUT_HINT` appended: don't repeat the command,
  narrow it (skip `bin/`, `obj/`, `node_modules/`, `.git/`; cap with `head`). `finish_reason`
  `tool_calls` → `stop_reason: "tool_use"`, `length` → `max_tokens`, else `end_turn`;
  `stop_sequences` are applied to the text (→ `stop_sequence`). `usage` carries
  `input_tokens`/`output_tokens` plus the proxy's `x_m365_*` diagnostics.
- **Streaming is buffered.** With `stream: true` the M365 turn runs to completion (an SSE
  comment `: keepalive` every 15 s keeps the connection open), then the whole message is
  sent as the standard event sequence (`message_start`, `content_block_start/delta/stop`,
  `message_delta`, `message_stop`). Text is not token-live. Errors arrive as an `error` event.
- **Errors.** Anthropic error shape (`{type:"error", error:{type, message}}`). An empty or
  `Disengaged` M365 turn is a **400** `invalid_request_error`, not a 5xx: Claude Code
  retries 5xx up to ten times, and each retry would start a new M365 thread — what the
  thread-rate throttle counts. A 429 stays a 429 `rate_limit_error` with its `Retry-After`.
- **`POST /v1/messages/count_tokens`** returns `{input_tokens}` estimated at ~4 characters
  per token (M365 has no matching tokenizer).
- **`GET /v1/models`** answers in the Anthropic Models API shape (`{data:[{id, type:"model",
  display_name, created_at, max_input_tokens, max_tokens}], first_id, last_id, has_more}`)
  when the request has an `anthropic-version` header or `x-m365-claude-code: 1`. IDs are
  prefixed `claude-m365--`, because Claude Code's gateway model discovery only lists IDs
  starting with `claude`/`anthropic`. Other clients get the OpenAI list as before.

Claude Code prints a one-line warning that it doesn't recognise the model name and
assumes a 200k-token context window. It is harmless; M365 accepts more.

**On a basic (non-premium) M365 Copilot account** (seen 2026-10-28):
- Use `MODEL=gpt-6.1-sol`. It works on every account and made real tool calls from Claude
  Code. `gpt-5.5-think-deeper` tended to answer from M365's own `/mnt/data` sandbox
  ("the files are not mounted here"), and `claude-sonnet` never answered at all; our
  guess is the tenant hasn't enabled Anthropic models.
- The framing tells the model that *the user* runs each command it
  writes and pastes the output back. The proxy turns those commands into real tool calls,
  so it works, but asked about itself the model will say "you executed it on your
  machine". That is expected. Give it tasks, not questions about its abilities.
- **New user messages get a tool reminder** (`NEW_USER_TURN_REMINDER` in
  `proxy-lib/src/handler.ts`, all clients, tool requests only). Follow-up turns send M365
  only the new messages, so in a long session the tool instructions are many turns back.
  Seen at turn 24 of a Claude Code session: asked "run tests", the model replied "no
  executable tool is available to me in this turn". Now a follow-up that carries a new user
  message ends with a one-line `<harness_note>` saying it is not part of the request and
  that tool blocks still work. (A first version began "Same as before:", and the model read
  that as part of the request.) The "gave up" detector
  (`looksLikeConfabulation`) also catches "can't *actually* run …" and "no … tool is
  available", and then retries once.
- **"Please run: ```bash …``` … paste the output" is executed** (`asksUserToRun` in
  `core/src/tools.ts`). The prose-document guard (don't execute the example commands in
  a README the model writes) used to swallow this reply when a long "I can't run it
  myself" intro came first. Now, if there is no markdown heading, the line before the
  first block asks to run (ends in `run …:`), and the reply asks for the output or gives
  up, the first block runs as a tool call.
- The `relay` framings now also name GPT's own sandbox as the wrong machine (`python`,
  `container.exec`, `/mnt/data`, next to Claude's `/home/claude`, `/mnt/user-data`), and
  "not present in the current execution environment … /mnt/data" counts as giving up.
  `M365_NO_CODE_INTERPRETER=1` does not help: upstream found GPT-6 Sol's sandbox runs
  without those optionsSets (`docs/hypotheses.md` §23 F50).
- **Sandbox commands are re-routed to your machine** (`sandboxCommandAsShellCall` in
  `core/src/fenced.ts`). When the model runs a command in M365's own sandbox instead of
  writing a tool block, M365 reports it in a progress frame (`contentType: "Code"`,
  `hiddenText: "bash -lc <cmd>"`; recorded as `sandboxCode` on the stream). If the reply
  has no tool call, the proxy takes the last such command that doesn't search the sandbox
  itself (no `/mnt`, `/home/oai`, or bare `/` argument) and returns it as a call to the
  harness's shell tool, so it runs locally. Python cells are not translated. Seen:
  `pwd && ls -la && find .. -maxdepth 3 -name '*.sln' | head && dotnet build` ran in
  `/mnt/data` ("dotnet: command not found").
- The per-message `<harness_note>` also says: never run commands or look for files in your
  own sandbox (python, container.exec, `/mnt/data`).

Limits: M365 tool calling is prompt-emulated, so it is less reliable than real Claude;
this is wire compatibility, not an Anthropic model. Ported from the
[NightMean/m365-copilot-proxy-claude](https://github.com/NightMean/m365-copilot-proxy-claude)
fork (branch `anas/myclaude-verified-orchestrator`).

### 5. Use with OpenClaw

```sh
# Configure and start in one command
m365-openclaw-setup --start

# Or configure only, then start separately
m365-openclaw-setup
m365-proxy 4141
```

The proxy uses session reuse and delta messages — follow-up turns only send new messages, saving M365 quota. New conversations are detected automatically when the message array shrinks or the first user message changes.

### 6. Use as standalone proxy

```sh
npx m365-proxy 4141
# or
pnpm run dev
```

Then point any OpenAI-compatible client at `http://localhost:4141/v1`.

The `m365-proxy` launcher binds to **`127.0.0.1`** unless `HOST` (or `NITRO_HOST`) is set —
Nitro on its own would listen on every interface, letting anyone on the network use your
M365 account. To expose it on purpose, set `HOST=0.0.0.0` **and** `M365_PROXY_API_KEY`.

#### Temporary chats

Proxy conversations use M365 **temporary-chat mode by default**
(`disableMemory=1` on the authenticated Chathub URL), so they are not added to
the Copilot history sidebar while multi-turn context still works for the live
conversation. Set `M365_SAVE_HISTORY=1` before starting the proxy only if you
deliberately want proxy chats saved in Copilot history.

### 7. Run on NixOS (systemd service)

The proxy is a [Nitro](https://nitro.build/) service. The flake exposes a package
(built from the workspace via [pnpm2nix](https://github.com/cramt/pnpm2nix)) and a NixOS
module:

```nix
# flake.nix
{
  inputs.m365.url = "github:cramt/m365-copilot-proxy";

  outputs = { nixpkgs, m365, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        m365.nixosModules.default
        {
          services.m365-copilot-proxy = {
            enable = true;
            # port = 4141;          # default
            # host = "127.0.0.1";   # default — do not expose; unauthenticated, paid account
            # openFirewall = false;
          };
        }
      ];
    };
  };
}
```

The service runs as a hardened `DynamicUser` unit. Auth state (`msal-cache.json`)
persists in `/var/lib/m365-copilot-proxy`. Sign-in is interactive only
and the service has no display (it sets `M365_NO_INTERACTIVE=1`), so a fresh deploy needs a
token cache: sign in once on a desktop machine and copy its `msal-cache.json` to
`/var/lib/m365-copilot-proxy/.config/opencode-m365/`, owned by the service. Tokens then
refresh silently; when the refresh token finally expires, the service fails loudly and you
copy a fresh cache. The `secretsFile` option was removed. To run the package directly
without NixOS: `nix run github:cramt/m365-copilot-proxy -- 4141`.

## Available models

| Model ID | M365 Tone | Description |
|---|---|---|
| `gpt-6-think-deeper` | Gpt_6_Reasoning | GPT-6 reasoning. **Needs a paid/premium Copilot seat** (see below); 30/30 on the bench (agent-less, `relay` framing). Defaults to `relay_batch`: 20/20 at 2.1 turns per task (relay: 3.2), 10/10 driving real pi |
| `gpt-6-sol` | Gpt_6_Sol_Reasoning | GPT-6 Sol ("GPT 6.0 Sol" in the web UI). **Works on every account**, no paid seat needed; Defaults to `relay_batch`: 60/60 on the bench without the (now removed) agent, 30/30 driving real pi, at 2.1 turns per bench task either way |
| `gpt-6.1-sol` | Gpt_61_Sol_Reasoning | GPT-6.1 Sol ("GPT-6.1 Sol" in the web UI). **Works on every account**. Defaults to `relay_batch`: 40/40 on the bench, 30/30 driving real pi, at 2.2 turns per bench task, and it keeps out of its sandbox, which `gpt-6-sol` doesn't always (see below). **The default and recommended model** (when no model is sent, and in the pi / Claude Code launchers) |
| `gpt-5.6-think-deeper` | Gpt_5_6_Reasoning | GPT-5.6 reasoning — 27/30 on the bench, tied with `gpt-5.5-think-deeper` |
| `gpt-5.6` / `gpt-5.6-quick` | Gpt_5_6_Chat | GPT-5.6 fast ("GPT 5.6 Quick response" in the web UI). **Weak at tool calling** — 7/30 on the bench (see below) |
| `gpt-5.5-think-deeper` | Gpt_5_5_Reasoning | GPT-5.5 reasoning — 26/30 on the bench (measured with the now-removed agent). The default until 2026-10-28 |
| `gpt-5.5` / `gpt-5.5-quick` | Gpt_5_5_Chat | GPT-5.5 fast — 16/30 on the bench, the strongest benchmarked chat tone |
| `m365-copilot` / `auto` | magic | Auto-routing — high-variance at tool-calling (confabulates; see below) |
| `quick` | Gpt_5_5_Chat | Alias of `gpt-5.5` (its old `Gpt_Quick` tone was retired — see below) |
| `think-deeper` | Gpt_5_5_Reasoning | Alias of `gpt-5.5-think-deeper` (its old `Gpt_Reasoning` tone was retired) |
| `claude` / `claude-sonnet` / `claude-sonnet-4.6` | Claude_Sonnet | Real Anthropic Claude Sonnet 4.6 (agent-less path) — 78/90 on the bench with the `relay` framing (47/76 with `baseline`). Defaults to `relay_batch`: 40/40, and 21% fewer turns driving real pi (20/20). `claude-sonnet-4.5` is kept as an alias |
| `claude-sonnet-5.5` | Claude_Sonnet (paid scenario) | Claude Sonnet 5.5. **Needs a paid/premium Copilot seat** — same tone as above, the scenario picks the model — and has a separate quota: 80 turns a day, 150 a week (see below). Defaults to `relay`, inherited from Sonnet 5 (not benchmarked yet) |
| `claude-sonnet-5` | Claude_Sonnet_5 (paid scenario) | Claude Sonnet 5. **Needs a paid/premium Copilot seat**; no separate quota. 27/30 on the bench with the `relay` framing (6/40 with `baseline`; see below) |
| `claude-sonnet-think-deeper` | Claude_Sonnet_Reasoning | Claude reasoning |
| `claude-opus` / `claude-opus-5.5` | Claude_Opus (paid scenario) | Claude Opus 5.5. **Needs a paid/premium Copilot seat** and has a small separate quota: 40 turns a day (see below). 10/10 on the bench with `relay`; defaults to `relay_batch`. `claude-opus-5` is kept as an alias |
| `claude-opus-4.8` | Claude_Opus (included scenario) | Claude Opus 4.8. **Premium accounts only**, but **no** priority-access quota. With its default `relay_batch` framing: 30/30 on the bench at 2.5 turns per task (measured with the now-removed agent; agent-less solved the same under `relay_batch`), 10/10 driving real pi. `claude-opus-4.5` is kept as an alias (it was Opus 4.5 until October 2026) |
| `gpt-5.4` / `gpt-5.4-quick` | Gpt_5_4_* | GPT-5.4 |
| `gpt-5.3` / `gpt-5.3-think-deeper` | Gpt_5_3_* | GPT-5.3 |
| `gpt-5.2` / `gpt-5.2-think-deeper` | Gpt_5_2_* | GPT-5.2 |

Bench scores are 10 tasks × 3 reps with the confab-retry **off** (`M365_NO_CONFAB_RETRY=1`), so
every first-try give-up counts, including ones the proxy's retry would normally recover
([hypotheses §19](docs/hypotheses.md)). GPT-6's 24/30 was measured with the retry on, so it
isn't directly comparable.

> **Microsoft retired the `*_Quick` tones; `*_Chat` tones replaced them.** Every `quick` /
> `*-quick` model ID still works and resolves to the replacement `*_Chat` tone (e.g.
> `gpt-5.3-quick` → `Gpt_5_3_Chat`), so existing configs need no change.

> ✅ **For tool calling, use `gpt-6.1-sol` (the default when no model is sent, since
> 2026-10-28).** It works on every account with no paid seat, scored 40/40 on the bench and
> 30/30 driving real pi with `relay_batch`, all without the Copilot Studio agent, and keeps out
> of M365's own `/mnt/data` sandbox (see [GPT-6.1 Sol](#gpt-61-sol-gpt-61-sol--gpt-6-sols-routing-and-the-relay_batch-framing)).
> It also made real tool calls from Claude Code on a basic account, where
> `gpt-5.5-think-deeper` tended to answer from the sandbox. `gpt-5.5-think-deeper`, the old
> default, scored 26/30 on the bench, but that was measured with the agent, which is now
> removed. The **`m365-copilot` (magic) tone is *not* reliable** for tools — it confabulates
> ("I no longer have access to the filesystem tools") and solves ~0% of real tasks (§12.11).
>
> ⚠️ The **older** reasoning tones (`gpt-5.2`/`gpt-5.3`/`gpt-5.4` `*-think-deeper`, bare
> `gpt-5.4`) route through M365's `DeepLeo` pipeline, which meta-analyzes the
> injected prompt and can disengage from tools. Prefer `gpt-6.1-sol`.
> See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) §5/§10.

### GPT-5.6 chat (`gpt-5.6` / `gpt-5.6-quick`) — newer, and worse at agentic work

The web client calls this one **"GPT 5.6 Quick response"**, which is the shape to expect:
it is the chat sibling of `gpt-5.6-think-deeper`, not a reasoning tone, and it self-identifies
as "the GPT-5 chat model" — exactly as `Gpt_5_5_Chat` does. Neither tone will tell you which
generation is actually answering, so don't pick between them on self-report.

**Pick it for chat, not for tools.** A higher version number is not an upgrade here: on the
bench it solves **7/30**, against **16/30** for `gpt-5.5`. Its low message count (39 vs 69)
is not efficiency: 22 of its 23 failures gave up before making a single tool call. See
[hypotheses §19](docs/hypotheses.md).

**No entitlement needed.** It reaches a model on the default `OfficeWebIncludedCopilot`
scenario, so the proxy sends nothing special for it. This is newly true: until recently the
tone deflected with the canned `BotConnection` apology on the included scenario while serving
normally under `OfficeWebPaidCopilot` — it was entitlement-gated like Opus, which
[hypotheses §12.15](docs/hypotheses.md) had misfiled as a permanently dead route.
See [§18](docs/hypotheses.md) for the correction.

### GPT-6 (`gpt-6-think-deeper`) — entitlement, but no separate quota

**It needs the paid scenario, exactly like Opus.** On the default
`OfficeWebIncludedCopilot` the `Gpt_6_Reasoning` tone is accepted and then deflects with the
canned apology; under `OfficeWebPaidCopilot` it serves normally. The proxy sends the paid
scenario automatically whenever the resolved tone is `Gpt_6_Reasoning`, so nothing has to be
configured — but this is an **entitlement, not a bypass**, and a seat without paid/premium
access will see the apology no matter which scenario is requested.

**It is not metered separately, and that is the part worth stating.** The paid scenario is an
entitlement gate; it does not imply a budget. GPT-6 has no priority-access allowance and is
throttled by the same per-conversation cap and thread-rate governor as every other model, so
none of the Opus advice about rationing turns applies.

**Tool calls use a `relay` framing.** (With the old Copilot Studio tool agent attached,
`Gpt_6_Reasoning` didn't serve at all, #41; the agent is now removed.) Under the
`baseline` framing GPT-6 worked in M365's own code interpreter instead of calling your tools:
0/30 on the bench. Under `relay` it scored **30/30** (confab-retry off, 2026-10-01), and 5/5 driving
real pi. The default is now `relay_batch`, which asks it to put as much as it can into each block:
20/20 on the bench at 2.1 turns per task against relay's 3.2, and 10/10 through real pi at 3 turns
per run (hypotheses §25). `M365_FRAMING_VARIANT` still overrides it.
`gpt-6.1-sol` is the recommended default and the no-model fallback, not GPT-6, because GPT-6
needs an entitlement most seats don't have; GPT-6.1 Sol needs none.

### GPT-6 Sol (`gpt-6-sol`) — no entitlement

The web client calls it **"GPT 6.0 Sol"**; the tone is `Gpt_6_Sol_Reasoning` and it identifies
itself as the GPT-6 reasoning model. Unlike `gpt-6-think-deeper` it is **not** entitlement-gated: it
serves on the default included scenario on premium and non-premium accounts alike, so the proxy
sends nothing special for it.

**It has a sandbox of its own.** It runs `bash` in a remote machine (`/mnt/data`,
`/home/oai`), finds none of your files there, and asks you to upload them, or hands back a Teams link
to a file it made. Turning off M365's code interpreter (`M365_NO_CODE_INTERPRETER=1`) doesn't stop
it. The user-voice `relay` framing does: on the bench it solved 60/60, against 0–6/10 for every other
framing. Its batching variant, `relay_batch`, is the default: it keeps relay's wording and asks for
one script per turn, which cut the turns by a third on the bench (60/60) and by a
fifth to a quarter in real pi (30/30 runs). It doesn't send GPT-6 Sol to its sandbox any more often
than `relay` (an earlier, smaller run suggested it did; the retest found no difference). Details:
[hypotheses §23, §28](docs/hypotheses.md).

### GPT-6.1 Sol (`gpt-6.1-sol`) — GPT-6 Sol's routing, and the `relay_batch` framing

The web client calls it **"GPT-6.1 Sol"**; the tone is `Gpt_61_Sol_Reasoning`, and like GPT-6 Sol it
identifies itself as the GPT-6 reasoning model. It is routed exactly like `gpt-6-sol`: the default
included scenario, which serves it on premium and non-premium accounts alike.

**It has a separate allowance, which the proxy doesn't use.** The paid scenario serves it too, but
every paid turn spends a GPT-6.1 Sol allowance of 40 turns a day and 75 a week, the size of Opus
5.5's; included turns spend nothing, and a non-premium account can't use the paid scenario at all.
So the proxy stays on the included one. Whether the paid scenario serves a newer model behind the
same name is still open: the model can't tell you, since its self-description is M365's.

**It defaults to `relay_batch`.** It has a sandbox like GPT-6 Sol's,
and the framings that put the instructions in a `<system>` block send it there: `baseline` solved
0/20 and `minimal` 2/20. The framings written as the user's own request kept it out entirely. As with
GPT-6 Sol, it went to the sandbox no more often under `relay_batch` than under `relay` (never, on the
bench), so here the turn saving decides: 40/40 on the bench against relay's 39/40 at 36% fewer turns,
and 30/30 runs driving real pi at 47% fewer turns (about 3 per run). Details: [hypotheses §27](docs/hypotheses.md).

**It matches GPT-6 Sol on the bench, but stays out of its sandbox.** Side by side
on both non-premium accounts, the two solved the same tasks at the same turns under every framing:
`relay_batch` and `honest` everything (about 2.1 and 2.9 turns per task), `baseline` and `minimal`
nothing. The difference is the sandbox: told by the user's note that it's the wrong machine, GPT-6.1
Sol never went into it under `relay_batch` (0 of 80 bench tasks and pi runs so far), where GPT-6 Sol
still looks around in it on about a quarter of tasks — harmless, but on a non-premium account
`gpt-6.1-sol` is the tidier of the two. It also shows the included scenario's GPT-6.1 Sol isn't GPT-6
Sol under a new name. Details: [hypotheses §29](docs/hypotheses.md).

### Sonnet 5 and 5.5 (`claude-sonnet-5`, `claude-sonnet-5.5`) — their own sandbox, and the `relay` framing

`Claude_Sonnet` is Sonnet 4.6 on the included scenario and **Sonnet 5.5** on the paid one, and
Sonnet 5 has its own tone, `Claude_Sonnet_5`, which is likewise Sonnet 4.6 unless the scenario is
paid. So both need a paid/premium seat, like Opus. Microsoft made that switch on 2026-10-06: before
it, the paid `Claude_Sonnet` was Sonnet 5, which is why `claude-sonnet-5` now maps to the new tone.

**Sonnet 5.5 is metered: 80 turns a day, 150 a week**, separately from Opus, one per turn (in a
coding loop, one per tool call). The proxy handles it like the Opus quota below:
`usage.x_m365_sonnet55_daily_remaining` / `x_m365_sonnet55_weekly_remaining` on every response, a
429 once it's used up, and an opt-in fallback, `M365_SONNET_FALLBACK_MODEL` (e.g. `claude-sonnet-5`,
which isn't metered). Sonnet 5 has no such quota.

Sonnet 5 arrives with **its own tools** (`bash_tool`, `create_file`, …) running in a remote
sandbox (`/home/claude`) that cannot see your files, and it reads the proxy's usual
`<system>`-tagged tool framing as a prompt injection — so with that framing it inspects its own
empty sandbox and reports that your files don't exist (6/40 on the bench). Sonnet 5.5 has the same
sandbox. The proxy therefore gives every Sonnet model a user-voice framing instead. Sonnet 5's
default is `relay`: a plain note
asking it to guide you through your terminal one command at a time, which also tells it the sandbox
is the wrong machine. That scores **27/30** on the bench (from 5/30) and solved **5/5** fix-bug runs
through real pi. Sonnet 4.6 beat `baseline` with it too (78/90 vs 47/76), and now defaults to
`relay_batch`, the same note asking it to put as much as it can into each block: same solves, 21%
fewer turns through real pi (39/39). On Sonnet 5 that saved only 6% in pi, so it stays on `relay`.
Sonnet 5.5 starts on `relay` too, until it has been benchmarked.
Override with `M365_FRAMING_VARIANT` as usual. Details: hypotheses §21, §25, §26.

### Opus (`claude-opus`, `claude-opus-4.8`) — two models, one with a small quota

The `Claude_Opus` tone serves two models, picked by the `scenario` the WebSocket is opened with:

| Model ID | Model | Scenario | Who can use it | Quota |
|---|---|---|---|---|
| `claude-opus` (`claude-opus-5.5`, `claude-opus-5`) | Claude Opus 5.5 | `OfficeWebPaidCopilot` | paid/premium seat | small priority-access quota |
| `claude-opus-4.8` (`claude-opus-4.5`) | Claude Opus 4.8 | `OfficeWebIncludedCopilot` | premium account | none beyond the usual throttling |

The proxy picks the scenario from the model ID, so nothing has to be configured. This is an
**entitlement, not a bypass**: without a paid/premium seat neither model serves. `claude-opus`
then gets a licence-refusal message, and `claude-opus-4.8` a 502 saying it's premium-only. `licenseType`
alone unlocks nothing; override either with `M365_SCENARIO` / `M365_LICENSE_TYPE`.

**Opus 4.8 has a code interpreter of its own**, and unless the framing steers it away it works
there instead of in your harness, reporting success on files it never touched. The default
`relay_batch` framing does steer it away: on the bench it solved the same with and without the old
Copilot Studio agent, which used to be the safety margin and is now removed. Until October 2026 this
route served Claude Opus 4.5 (only through that agent); `claude-opus-4.5` now reaches Opus 4.8 (see
hypotheses §24, §36).

**`claude-opus` is metered separately: 40 turns a day, 75 a week.** Opus 5.5 draws on a "priority
access" budget distinct from the ~600-message conversation cap, and **every M365 turn costs one,
whatever its size**. In an agent loop every tool call is a turn, so one coding task costs 3–5 and a
day's budget is gone after about ten tasks. That's what [issue #18](https://github.com/cramt/m365-copilot-proxy/issues/18)
ran into; a shorter prompt doesn't help. Both budgets reset at **midnight UTC**, the weekly one on Monday.

What the proxy does about it:
- **Shows the budget:** every `claude-opus` response carries `usage.x_m365_opus_daily_remaining` and
  `usage.x_m365_opus_weekly_remaining`.
- **Says when it's used up:** M365 ends the turn with a refusal (*"You've used your available priority
  access to the Opus model for today…"*), which the proxy turns into **HTTP 429**
  (`code: priority_access_exhausted`, `param: day|week`) with a `Retry-After` to the reset — on the
  streaming path an `error` chunk with the same fields. It then answers further `claude-opus`
  requests itself until the reset, without spending M365 turns on more refusals.
- **Can fall back to Opus 4.8:** with `M365_OPUS_FALLBACK_MODEL=claude-opus-4.8`, a `claude-opus`
  request that hits the wall is sent to `claude-opus-4.8` instead (unmetered, premium accounts only),
  and so is every later one until the reset. The response's `model` field says which model answered.
- **Spends fewer turns:** the `relay_batch` framing (below) asks the model to do as much as it can
  per tool call, and avoids the jailbreak-filter retries that cost `claude-opus`'s old default framing
  a wasted turn on about 40% of tasks.

**Both use the `relay_batch` framing.** On the bench Opus 4.5 solved nearly every
task whatever the framing, so two other things decided it. M365's jailbreak classifier: the proxy's
older `<system>`-tagged framings tripped it on a third of the tasks (each one a wasted turn and a
retry in a fresh conversation), the user-voice `relay` framings on none. And turns:
`relay_batch` asks the model to put as much as it can into each command block, which took Opus 4.5
from 3.65 to 2.30 turns per bench task (20/20 either way) and from 6 to 3.5 turns per real-pi run
(10/10 either way) — on Opus 5.5 that's ~17 tasks a day instead of ~11. The cost to watch is a
block that acts before it has seen any output; in pi every edit still came after a read. Opus 5.5
went 10/10 on the bench with `relay`; it hasn't been benched with `relay_batch` yet. Opus 4.8, which
replaced Opus 4.5, went 30/30 with it at 2.5 turns per task.
Override with `M365_FRAMING_VARIANT` as usual. Details: [hypotheses §24, §36](docs/hypotheses.md).

## Image generation

M365 Copilot generates images through a built-in server-side tool, and the core
package exposes it as one call. The picture comes back on a `GraphicArt` frame as
a URL (never as chat text), and the bytes sit behind a separate auth boundary —
`generateImage()` handles both, returning the image with bytes attached:

```ts
import { generateImage } from "@m365-copilot/core";

const [img] = await generateImage("A minimalist flat-design logo of a lighthouse, teal and white.");
// img.data      -> Buffer (real PNG, verified end-to-end)
// img.base64    -> same bytes, ready for an OpenAI-style b64_json response
// img.contentType, img.size, img.orientation
```

Everything the M365 web client can do is reachable — the proxy sends the same image
optionsSets it does. Steer type and aspect with options (they nudge the prompt the
way the GUI's meta-prompting does; the model still makes the final call):

```ts
await generateImage("a lighthouse on a cliff", { orientation: "portrait" });   // landscape | portrait | square
await generateImage("a lighthouse", { style: "icon" });                        // natural | icon | story | designer
```

**You don't have to call `generateImage` at all.** Just like the web client, a plain
chat turn draws when asked — send `"draw me an image of a green teapot"` to
`/v1/chat/completions` (or `ModelSession.run`) with no tools and the image comes back
embedded in the reply as a markdown data-URI. (Image gen is enabled on every chat
turn, tool requests included; set `M365_NO_IMAGE_GEN=1` to force pure text.)

Runs its own session. Uses the same login as chat; the artifact fetch uses
a `designerappservice` token acquired silently from the existing cache. Protocol
write-up: [docs/hypotheses.md §14](docs/hypotheses.md).

> **Separate, scarcer budget.** Image generation draws on its own daily quota, distinct
> from the ~600-message conversation limit and not metered by the chat throttle — treat
> image calls as the expensive ones. When it's exhausted, `generateImage()` throws
> `ImageGenerationError` with `reason: "quota_exceeded"` (map it to HTTP 429); a plain
> chat turn instead returns M365's "can't generate any more images today" message as text.

An OpenAI-compatible `POST /v1/images/generations` endpoint on top of this is the
next step — the core API it needs is already in place.

## Data flow and privacy

What leaves the machine, and to whom. Audited 2026-10-28 (static review of every
network call in `packages/`, a scan of the built server bundle including its bundled
dependencies, and a live Claude Code run with all other traffic logged and blocked).

**The proxy talks only to Microsoft.** Every outbound call in the runtime code:

| Destination | What is sent | Code |
|---|---|---|
| `login.microsoftonline.com` | Sign-in (MSAL, Microsoft's own first-party client ID `c0ab8ce9-…`), in a visible Chromium window where you type your own credentials; the proxy never sees your password | `core/src/auth.ts` |
| `wss://substrate.office.com/m365Copilot/Chathub/…` | The chat: the whole prompt — system prompt, messages, tool definitions and tool results (so file contents, command output, paths your agent reads) | `core/src/session.ts` |
| `substrate.office.com/m365Copilot/UploadFile` | Images in the conversation (base64 only) | `core/src/image-input.ts` |
| `*.officeapps.live.com` | Download a generated image with a token. The token is only sent to https Microsoft hosts (`isMicrosoftHttpsUrl`) | `core/src/image.ts` |

Not sent anywhere: no telemetry, analytics or crash reporting; no third-party hosts in
the source or the built bundle (the only non-Microsoft URLs are in code comments);
the lockfile pulls only from `registry.npmjs.org`. The `/v1/messages` adapter drops
Claude Code's `metadata` (its user ID) and other unknown fields; only the conversation
and tools reach M365. Proxy chats use M365 temporary-chat mode, so they don't appear in
your Copilot history (unless `M365_SAVE_HISTORY=1`).

**Local files** under `~/.config/opencode-m365/`: `msal-cache.json` (tokens, written
owner-only `0600` on Linux/macOS), `browser-profile/` (login
cookies), `login-debug/` (screenshots + HTML of a failed login). Debug logs and frame dumps
(prompts and replies) are written only with `M365_DEBUG`/`M365_TRACE`/`M365_DUMP_FRAMES`.

**Network exposure:** the server binds to `127.0.0.1` (see
[Use as standalone proxy](#6-use-as-standalone-proxy)); optional `M365_PROXY_API_KEY`.

**Claude Code** (via `scripts/claude-local.*`): with `ANTHROPIC_BASE_URL` on the proxy and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, a `claude -p` run made **no** connection
other than to the proxy. A control run without the launcher tried `api.anthropic.com`,
which shows the check works. Interactive mode was not covered by that test. Tools that
fetch the web on their own (WebFetch, WebSearch) are left out of the launcher's default
`--tools`. If you enable them, they reach the sites they're asked to fetch, and Claude
Code may contact Anthropic to check a domain's safety. Either way, the launcher's
**egress guard** (below) refuses every connection to an Anthropic host.

**Policy note:** the proxy presents itself as Microsoft's own web client (client ID,
headers, a login that avoids bot detection). It sends data only to Microsoft, but your organisation may still treat
this use of M365 as against its policy.

## Authentication

The auth flow uses Azure MSAL with PKCE:

1. **Silent refresh** — cached tokens from `~/.config/opencode-m365/msal-cache.json`. The
   normal path; costs nothing and opens nothing.
2. **Interactive sign-in** — the only login: a visible Playwright browser where you
   complete SSO/MFA yourself (§13), using the persistent `browser-profile/`. Refused with
   `M365_NO_INTERACTIVE=1` (headless hosts), which makes a missing token an error.

There is no stored-credentials login (removed 2026-10-28; see [Sign in](#2-sign-in)).
Both redeem the code against `https://login.microsoftonline.com/common/oauth2/nativeclient`
with PKCE. That redirect isn't a stylistic choice: the client is Microsoft's own Copilot app
(the Sydney scopes are granted to no other), so nobody can register a loopback URI — a
generated `http://localhost:<port>` callback is rejected with `AADSTS50011`, and the device-code
grant demands a `client_secret` only Microsoft holds (`AADSTS7000218`). Both measured live in
[§13](docs/hypotheses.md); don't spend probes re-deriving them.

Token scopes acquired:
- `substrate.office.com/sydney/*` — For M365 Copilot chat
- `designerappservice.officeapps.live.com/.default` — For fetching generated images (silently, from the cache)

No Power Platform or BAP scopes: the Copilot Studio agent was removed (see
[No Copilot Studio agent](#no-copilot-studio-agent-removed-2026-10-28)).

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` (truncated payloads) |
| `M365_LOG_FILE` | Debug log name, relative to `~/.config/opencode-m365/` (default `debug.log`; an absolute path is used as is). `M365_LOG_FILE=my/log.log` logs to `~/.config/opencode-m365/my/log.log`. |
| `M365_TRACE` | Set to `1` for full, untruncated debug logging (every WS frame/prompt/response) — implies `M365_DEBUG`. For reverse engineering. |
| `M365_LOG_STDOUT` | Set to `1` to mirror debug lines to the proxy's stdout as well as the log file, so you can watch a run without tailing it in a second terminal. Needs `M365_DEBUG` or `M365_TRACE` — on its own it logs nothing. |
| `M365_DUMP_FRAMES` | Set to `1` to write every WebSocket frame (both directions) to `~/.config/opencode-m365/frames/<requestId>.ndjson`. For offline diffing of new M365 fields. |
| `M365_FRAME_DIR` | Frame dump directory, relative to `~/.config/opencode-m365/` (default `frames`; an absolute path is used as is). `M365_FRAME_DIR=my/frames` dumps to `~/.config/opencode-m365/my/frames/`. |
| `M365_ALLOW_MULTI_TOOL` | Allow the model to emit multiple tool calls per turn (default: only the first is kept) |
| `M365_NO_EARLY_STOP` | Set to `1` to let a tool turn run to its end after the model starts writing its own `<tool_response>`. By default the proxy stops the turn once that invented tail passes `M365_EARLY_STOP_AFTER` chars (the invented part is cut either way), which saves minutes when the model invents the rest of the session (#65) |
| `M365_EARLY_STOP_AFTER` | How many chars of a model-written `<tool_response>` tail a tool turn may run before the proxy stops it (default `2000`; `0` stops at the tag). M365 keeps a short tail in the conversation and the model seems to follow it: stopping at the tag cost Sonnet 4.6 10% more turns in real pi, the default none measurable ([hypotheses §35](docs/hypotheses.md)) |
| `M365_INJECT_REPLY_TOOL` | Set to `1` to inject a synthetic `reply(text)` tool. Forces every turn to be a tool call, including pure-prose answers. Cleaner contract for the model, +1 tool to the prompt (watch the Disengaged threshold). Confirmed 5/5 compliance on June 9 2026 ([hypotheses §1.1](docs/hypotheses.md)). |
| `M365_NO_FENCE_RETRY` | Set to `1` to stop the proxy asking the model once more, in the same conversation, for a tool call it wrote but the parser couldn't read (unclosed fence, edit without SEARCH/REPLACE markers, one-line fence). By default it asks once (one extra upstream turn), and then skips the confab forcing retry for that turn (upstream PR #71) |
| `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES` | M365's chat model sometimes produces prose instead of a tool call when it should act — either confabulating an inability ("I can't access the files, please paste them") **or** claiming a completion it never did ("I've replaced the README", with no tool call). By default the proxy detects both and re-prompts forcefully **in the same conversation** (`M365_CONFAB_RETRIES`, default `1`) to force a real action. Set `M365_NO_CONFAB_RETRY=1` to disable. |
| `M365_NO_BACKOFF` (alias `M365_NO_AUTO_REAUTH`) | Set to `1` to disable degradation backoff. By default, when empty/throttled responses span several **distinct conversations** in a short window (the thread-rate-throttle signature, [F13](docs/hypotheses.md)), the proxy **paces subsequent turns** (a jittered delay before starting new backend conversations) to let the account self-heal. This replaced the old auto-reauth: a fresh login does **not** clear this throttle (it's `oid`-keyed — [§11 H-R1](docs/hypotheses.md)) and raised our detection profile. A single long pi thread never trips the trigger. |
| `M365_BACKOFF_THRESHOLD` / `M365_BACKOFF_WINDOW_MS` / `M365_BACKOFF_BASE_MS` / `M365_BACKOFF_MAX_MS` | Tune backoff: distinct-conversation empties to trigger (default `3`), the window they must fall in (default `120000`), the initial pacing window (default `90000`), and its escalation cap (default `600000`). |
| `M365_AVOID_THROTTLING` | Set to `1` to keep the account clear of M365's `PerUserThrottled` throttle. A long pi session or a bench sweep trips it by running the account's turn budget dry (~100 turns, refilled at ~1.6 a minute, [hypotheses §24 F58](docs/hypotheses.md)), and it then refuses every turn for about an hour. With this set, the proxy waits before each upstream turn until the budget holds that turn plus a reserve of 20. A streamed request waits on its keepalive chunks, so pi doesn't time out, and the session runs at ~1.6 turns a minute once the budget is low. After a throttled turn the proxy holds new turns for 75 minutes and answers them with a 429 (`m365_throttle_hold`, with `Retry-After`) instead of sending them: each one would keep the throttle alive. The budget is read from the debug logs under `~/.config/opencode-m365`, so with `M365_DEBUG=1` it also counts the bench's and other proxies' turns and survives a restart. Without it, only this process's turns since it started count. The bench uses the same variable ([scripts/bench/README.md](scripts/bench/README.md)). Off by default. [Hypotheses §37](docs/hypotheses.md). |
| `M365_BUDGET_MAX_WAIT_MIN` | The longest `M365_AVOID_THROTTLING` holds a streamed request (default `15`, enough to refill an empty budget). A longer wait, usually a throttle hold, gets the 429 instead. A request that isn't streamed waits at most 2 minutes, since it sends nothing until the answer and clients give up on it after 5. Both limits count the time a request spends behind others waiting their turn. A larger value (e.g. `90`) lets a streamed request sit out a throttle hold instead of failing: pi has no time limit on a stream that keeps sending data. |
| `M365_BUDGET_CAPACITY` / `M365_BUDGET_REFILL` / `M365_BUDGET_RESERVE` / `M365_BUDGET_HOLD_MIN` / `M365_BUDGET_LOGS` | Tune `M365_AVOID_THROTTLING`'s budget model: its size (default `100` turns), refill rate (`1.6` a minute), the reserve kept back (`20`), the hold after a throttled turn (`75` minutes), and more log files or directories to read (`:`-separated). |
| `M365_BROWSER_PROFILE` / `M365_LOGIN_UA` | Override the persistent browser-profile dir and the User-Agent of the sign-in window. The persistent profile keeps AAD SSO/device cookies so repeat logins are silent and look like a familiar device ([§11 H-R3](docs/hypotheses.md)). |
| `M365_NO_INTERACTIVE` | Set to `1` to never open the sign-in window. For systemd/CI hosts: a missing or expired token is then an error. Copy `msal-cache.json` from a desktop sign-in instead. |
| `M365_INTERACTIVE_TIMEOUT_MS` | How long to wait for you to finish the interactive sign-in (default `600000`, i.e. 10 minutes). |
| `M365_LOGIN_LOCALE` / `M365_LOGIN_TIMEZONE` | Browser locale and timezone presented during login (defaults `en-GB` / `Europe/Copenhagen`). These are part of the anti-bot-scoring fingerprint ([§11 F25](docs/hypotheses.md)) — set them to match your own machine if AAD starts treating the sign-in window as a bot. |
| `M365_OPUS_FALLBACK_MODEL` | Model to serve `claude-opus` (Opus 5.5) requests with once its priority-access budget is used up, instead of returning a 429 — typically `claude-opus-4.8`, which isn't metered (premium accounts only). Applies until the budget resets; the response's `model` field names the model that answered. Unset by default. |
| `M365_SONNET_FALLBACK_MODEL` | The same for `claude-sonnet-5.5` (Sonnet 5.5) once its priority-access budget is used up — e.g. `claude-sonnet-5` (unmetered) or `claude-sonnet` (Sonnet 4.6, any account). A fallback naming a metered model is ignored. Unset by default. |
| `M365_SCENARIO` / `M365_LICENSE_TYPE` | Override the entitlement the WebSocket is opened under (defaults: `OfficeWebIncludedCopilot` / `Starter`, switching to `OfficeWebPaidCopilot` / `Premium` for the entitlement-gated models — `claude-opus`, `gpt-6-think-deeper`, `claude-sonnet-5` and `claude-sonnet-5.5`; `claude-opus-4.8` and `gpt-6.1-sol` stay on the included one). `scenario` is what gates the model list (and picks Sonnet 4.6 vs 5.5 for the `Claude_Sonnet` tone, Sonnet 4.6 vs 5 for `Claude_Sonnet_5`, Opus 4.8 vs 5.5 for `Claude_Opus`); `licenseType` rides along and unlocks nothing by itself. Forcing the paid scenario on `gpt-6.1-sol` spends its separate GPT-6.1 Sol allowance (40 turns a day, 75 a week), which the proxy doesn't track. |
| `HOST` / `NITRO_HOST` | Address the server binds to. The `m365-proxy` launcher defaults it to `127.0.0.1`. |
| `M365_PROXY_API_KEY` | Require this key on every `/v1/*` route except `GET /v1/models`, as `Authorization: Bearer <key>` or `x-api-key: <key>` (constant-time compare; else 401). Unset (default): no check. |
| `M365_CLAUDE_CODE_MODEL` | Proxy model for `/v1/messages` requests that name a model the proxy doesn't know (Claude Code's own model names). Default: the chat default, `gpt-6.1-sol`. |
| `M365_CACHE_FILE` | Override MSAL token cache location |
| `M365_SECRETS_FILE` | Only used to find a leftover `secrets.json` and warn you to delete it |
| `CHROMIUM_PATH` | Path to the Chromium binary for the sign-in window |

### Usage / context-window % in responses

The OpenAI `usage` block in every chat completion response now includes M365
extension fields with the **per-conversation message quota** — the closest
proxy we have to "context-window utilisation" since M365 hides token counts:

```json
"usage": {
  "prompt_tokens": 0,
  "completion_tokens": 0,
  "total_tokens": 0,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_message_type": null,
  "x_m365_turn_count": 3,
  "x_m365_classifier_scores": {
    "BotOffense": 1.27e-7,
    "dea_violation": 2.81e-6
  },
  "x_m365_dea_score": 2.81e-6,
  "x_m365_offense_score": 1.27e-7
}
```

`x_m365_dea_score` is M365's own "disengaged-eligible answer" classifier
score — the closest signal to "am I about to get Disengaged?". Empirically:
clean tool calls sit at ~1 × 10⁻⁸, prose at ~1 × 10⁻⁶, jailbreak-shaped
prompts at ~1 × 10⁻³. Disengaged itself fires at some threshold > 2 × 10⁻³
that we haven't yet pinpointed. Clients can monitor this to back off before
tripping the filter.

Clients that ignore unknown extension fields keep working; curious users can
read them. See [docs/hypotheses.md §0](docs/hypotheses.md) for the full
findings dump and [§2](docs/hypotheses.md) for what we tried and didn't find.

## Config files

All stored in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `msal-cache.json` | MSAL token cache (auto-managed) |
| `debug.log` | Debug log (when `M365_DEBUG=1`; renamed by `M365_LOG_FILE`) |
| `frames/` | WebSocket frame dumps (when `M365_DUMP_FRAMES=1`; moved by `M365_FRAME_DIR`) |

## Development

```sh
pnpm install
pnpm build            # Build all packages
pnpm run dev          # Start standalone proxy on :4141
pnpm run test:unit    # Run vitest unit tests (no auth/network)
pnpm run test:live    # Run live integration tests against M365
```

## Known limitations

- **M365 "disengages" on large tool payloads** — heavy agent harnesses (e.g. opencode's ~15-tool prompt) get empty `Disengaged` responses. Keep the toolset lean (this is why [pi](https://pi.dev/) works well). A heavy harness can be trimmed to fit, though opencode in particular needs that done in the proxy rather than through its own config, and its tool count has since dropped — see [docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter).
- Tool calling is emulated (prompt injection + fenced/shell framing), not native function calling — reliable on the tuned models and framings, less so elsewhere
- The `think-deeper` / `*_Reasoning` models take 10-30s per response
- Hard quota of ~600 messages **per conversation** (mitigated by session reuse + delta sends)
- `claude-opus` needs a paid/premium seat and has its own small priority-access quota (40 turns a day, 75 a week; every tool call is a turn) that resets at midnight UTC (weekly on Monday); exhaustion surfaces as a 429, or as a switch to `M365_OPUS_FALLBACK_MODEL`. `claude-opus-4.8` needs a premium account too, but has no such quota
- `claude-sonnet-5.5` needs a paid/premium seat and has a priority-access quota of its own (80 turns a day, 150 a week), handled the same way (`M365_SONNET_FALLBACK_MODEL`). `claude-sonnet-5` needs the seat but has no quota
- Streaming: **tool-less** responses stream incrementally (deltas forwarded as they arrive). **Tool-calling** turns are still buffered server-side — the raw text has to be parsed for tool-call fences before it can be emitted — so those arrive as a single chunk at the end (with an immediate HTTP 200 + heartbeats so the client never times out waiting)

## License

[MIT](LICENSE). Use at your own risk — this speaks to Microsoft's API with your own
credentials, on your own account, and that's between you and your tenant's
acceptable-use policy.

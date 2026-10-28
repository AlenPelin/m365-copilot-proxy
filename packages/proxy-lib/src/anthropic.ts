// Anthropic Messages API (`POST /v1/messages`) on top of the OpenAI chat handler,
// so Claude Code (and Anthropic SDK clients) can use the proxy. Ported from the
// NightMean/m365-copilot-proxy-claude fork (branch anas/myclaude-verified-orchestrator)
// and adapted to this handler. It is a translation layer only: the request becomes
// an OpenAI chat request, runs through handleChatCompletion (non-streaming), and the
// finished turn is rendered back as an Anthropic message or SSE stream.
import { z } from "zod/v4";
import { getAvailableModels } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { handleChatCompletion, type SessionPool } from "./handler.js";

// Blocks are checked per type in the translation below, so the schema stays loose:
// Claude Code adds fields (cache_control, citations, …) that we just ignore.
const Block = z.object({ type: z.string() }).passthrough();

const AnthropicMessage = z.object({
  // Some clients (Cursor, older Claude Code) send system text as a message.
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(Block)]),
});

export const AnthropicMessagesRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  messages: z.array(AnthropicMessage).min(1),
  system: z.union([z.string(), z.array(Block)]).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
  }).passthrough()).optional(),
  tool_choice: z.object({ type: z.enum(["auto", "any", "none", "tool"]), name: z.string().optional() }).passthrough().optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
}).passthrough();

export type AnthropicBody = z.infer<typeof AnthropicMessagesRequest>;
type AnyBlock = z.infer<typeof Block> & Record<string, any>;

/** A request the bridge can't forward faithfully. Answered as a 400, never dropped silently. */
export class UnsupportedContentError extends Error {}

type OpenAIPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

// Anthropic image block → OpenAI image_url part. The handler uploads image_url
// parts from any message (core image-input.ts), tool results included. Only
// inline base64 images: the upload takes data URLs, and the proxy never fetches
// a client-supplied URL.
function imagePart(block: AnyBlock): OpenAIPart {
  const src = block.source ?? {};
  if (src.type === "base64" && typeof src.data === "string") {
    return { type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } };
  }
  throw new UnsupportedContentError(`image source "${src.type}" is not supported (send the image as base64)`);
}

function textOf(block: AnyBlock): string {
  if (block.type === "text") return String(block.text ?? "");
  // A plain-text document (Claude Code sends these for some attachments).
  if (block.type === "document" && block.source?.type === "text") return String(block.source.data ?? "");
  throw new UnsupportedContentError(`${block.type} blocks are not supported here`);
}

/** Collapse parts to a string when there are no images (what most of the handler expects). */
function packParts(parts: OpenAIPart[]): string | OpenAIPart[] {
  return parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts;
}

function systemText(system: AnthropicBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => textOf(b as AnyBlock)).join("\n\n");
}

export function anthropicMessagesToOpenAI(body: AnthropicBody): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const toolNames = new Map<string, string>();

  const systemParts: string[] = [];
  const top = systemText(body.system);
  if (top) systemParts.push(top);
  const turns = body.messages.filter((m) => {
    if (m.role !== "system") return true;
    const text = typeof m.content === "string" ? m.content : m.content.map((b) => textOf(b as AnyBlock)).join("\n\n");
    if (text) systemParts.push(text);
    return false;
  });
  if (systemParts.length) out.push({ role: "system", content: systemParts.join("\n\n") });

  for (const m of turns) {
    if (typeof m.content === "string") {
      out.push({ role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    const blocks = m.content as AnyBlock[];

    if (m.role === "assistant") {
      const text: string[] = [];
      const calls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const b of blocks) {
        if (b.type === "text") text.push(String(b.text ?? ""));
        else if (b.type === "tool_use") {
          toolNames.set(b.id, b.name);
          calls.push({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } });
        }
        // thinking / redacted_thinking: our replies never carry them, but a
        // session that started on real Anthropic might. They are the model's own
        // scratchpad, so dropping them doesn't change what the tools returned.
        else if (b.type === "thinking" || b.type === "redacted_thinking") continue;
        else throw new UnsupportedContentError(`${b.type} is not supported in an assistant message`);
      }
      out.push({ role: "assistant", content: text.join("\n") || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // user: text/images, interleaved with tool results (each becomes a `tool` message).
    let pending: OpenAIPart[] = [];
    const flush = () => {
      if (pending.length) out.push({ role: "user", content: packParts(pending) });
      pending = [];
    };
    for (const b of blocks) {
      if (b.type === "image") pending.push(imagePart(b));
      else if (b.type === "tool_result") {
        flush();
        const parts: OpenAIPart[] = typeof b.content === "string"
          ? [{ type: "text", text: b.content }]
          : (b.content ?? []).map((c: AnyBlock) => (c.type === "image" ? imagePart(c) : { type: "text" as const, text: textOf(c) }));
        if (b.is_error) parts.unshift({ type: "text", text: "[tool error]\n" });
        // Claude Code swaps an oversized result for a file path + 2KB preview. Left
        // alone, M365 models retry near-identical commands and hit it again (seen:
        // 14 turns in a .NET repo, `find`/`sed` over bin/ and obj/). Say what happened.
        if (parts.some((p) => p.type === "text" && p.text.includes("<persisted-output>"))) {
          parts.push({ type: "text", text: PERSISTED_OUTPUT_HINT });
        }
        const name = toolNames.get(b.tool_use_id);
        out.push({ role: "tool", tool_call_id: String(b.tool_use_id), ...(name ? { name } : {}), content: packParts(parts) });
      } else pending.push({ type: "text", text: textOf(b) });
    }
    flush();
    if (blocks.length === 0) out.push({ role: "user", content: "" });
  }
  return out;
}

export const PERSISTED_OUTPUT_HINT =
  "\n[note: this output was too large, so only its start is shown above. Don't repeat the command. " +
  "Narrow it instead: skip build and dependency folders (bin/, obj/, node_modules/, .git/), " +
  "print only the lines you need, and cap the rest (e.g. `| head -n 200`).]";

function mapToolChoice(choice: AnthropicBody["tool_choice"]) {
  if (!choice || choice.type === "auto") return "auto" as const;
  if (choice.type === "any") return "required" as const;
  if (choice.type === "none") return "none" as const;
  return { type: "function" as const, function: { name: String(choice.name) } };
}

/**
 * Claude Code's gateway model discovery only lists IDs that start with `claude`
 * or `anthropic`, so /v1/models advertises `claude-m365--<id>` to it. The prefix
 * is transport-only and stripped here.
 */
export const CLAUDE_GATEWAY_MODEL_PREFIX = "claude-m365--";

/**
 * Map the model Claude Code asks for onto a proxy model. An exact proxy ID (or a
 * prefixed one) wins. Anything else — Claude Code's own names such as
 * `claude-sonnet-4-5-20250929`, or the haiku model it uses for background work —
 * goes to M365_CLAUDE_CODE_MODEL, else the chat schema's default.
 */
export function resolveM365Model(requested: string): string | undefined {
  const known = new Set(getAvailableModels());
  const id = requested.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX) ? requested.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length) : requested;
  if (known.has(id)) return id;
  const configured = process.env.M365_CLAUDE_CODE_MODEL;
  return configured && known.has(configured) ? configured : undefined;
}

/** Translate an Anthropic Messages request into the proxy's OpenAI chat request. */
export function toOpenAIChatRequest(body: AnthropicBody) {
  return ChatCompletionRequest.parse({
    model: resolveM365Model(body.model),
    messages: anthropicMessagesToOpenAI(body),
    stream: false,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    tools: body.tools?.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: "object", properties: {} } },
    })),
    tool_choice: body.tools?.length ? mapToolChoice(body.tool_choice) : undefined,
  });
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContent[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; [k: string]: unknown };
}

function parseToolInput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Cut text at the first stop sequence, as Anthropic does. */
function applyStopSequences(text: string, seqs: string[] | undefined): { text: string; hit: string | null } {
  let cut = -1;
  let hit: string | null = null;
  for (const s of seqs ?? []) {
    const i = s ? text.indexOf(s) : -1;
    if (i >= 0 && (cut < 0 || i < cut)) { cut = i; hit = s; }
  }
  return cut < 0 ? { text, hit: null } : { text: text.slice(0, cut), hit };
}

/**
 * Remove M365 web-UI markup the model leaks into prose: citation markers
 * (`\uE200cite\uE202<ref>\uE201`, shown as "citeturn0file1") and `<File>name</File>`
 * file chips (kept as the bare name). Text blocks only — tool inputs are left as is,
 * since a command or file body may legitimately contain `<File>` (e.g. WiX XML).
 */
export function stripM365Markup(text: string): string {
  return text
    .replace(/\uE200[^\uE201]*\uE201/g, "")
    .replace(/<File>([^<\n]*)<\/File>/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

/**
 * GPT models in M365 put single values in their own plain code block ("around:",
 * ```text line 111```, "for exception/status-code translation."), which Claude
 * Code shows as three separate paragraphs. Turn a one-line block with no language
 * or `text`/`txt`/`plaintext` into inline code, joined into the sentence when it
 * follows "…:" (and the sentence after it, when that starts lowercase). Blocks with
 * a real language or more than one line are left alone. Text blocks only.
 */
export function inlineTinyCodeBlocks(text: string): string {
  const tiny = "```(?:text|txt|plaintext)?\\n([^\\n`]{1,100})\\n```";
  return text
    .replace(new RegExp(`([^\\n]*:)\\n\\n${tiny}(?:\\n\\n([a-z][^\\n]*))?`, "g"),
      (_m, before: string, code: string, after?: string) => `${before} \`${code.trim()}\`${after ? ` ${after}` : ""}`)
    .replace(new RegExp(`^${tiny}$`, "gm"), (_m, code: string) => `\`${code.trim()}\``);
}

/** Translate one finished OpenAI chat response into an Anthropic message. */
export function fromOpenAIChatResponse(payload: any, requestedModel: string, stopSequences?: string[]): AnthropicMessageResponse {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: AnthropicContent[] = [];
  let stopHit: string | null = null;

  if (typeof message.content === "string" && message.content.trim()) {
    const { text, hit } = applyStopSequences(inlineTinyCodeBlocks(stripM365Markup(message.content)), stopSequences);
    stopHit = hit;
    if (text) content.push({ type: "text", text });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: String(call.id),
      name: String(call.function?.name ?? "unknown"),
      input: parseToolInput(String(call.function?.arguments ?? "{}")),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const finish = choice.finish_reason;
  const stop_reason = finish === "tool_calls" ? "tool_use"
    : stopHit ? "stop_sequence"
    : finish === "length" ? "max_tokens" : "end_turn";
  // Pass the proxy's usage diagnostics (x_m365_*) through; they hold no secrets.
  const { prompt_tokens, completion_tokens, total_tokens: _t, ...extra } = payload?.usage ?? {};
  return {
    id: `msg_${String(payload?.id ?? crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "")}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason,
    stop_sequence: stopHit,
    usage: { input_tokens: Number(prompt_tokens ?? 0), output_tokens: Number(completion_tokens ?? 0), ...extra },
  };
}

function anthropicError(status: number, message: string, type = "api_error", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Render a finished Anthropic message as the standard Messages SSE event sequence. */
export function anthropicSseText(message: AnthropicMessageResponse): string {
  let out = sseEvent("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } },
  });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      out += sseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      if (block.text) out += sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      out += sseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      out += sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    out += sseEvent("content_block_stop", { type: "content_block_stop", index });
  });
  out += sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: message.usage.output_tokens },
  });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

async function produce(body: AnthropicBody, pool: SessionPool, signal?: AbortSignal): Promise<AnthropicMessageResponse | Response> {
  let openai;
  try { openai = toOpenAIChatRequest(body); }
  catch (err: any) { return anthropicError(400, err?.message ?? "invalid request", "invalid_request_error"); }

  const res = await handleChatCompletion(openai, pool, { signal });
  if (!res.ok) {
    let message = `M365 upstream returned HTTP ${res.status}`;
    let upstreamType = "upstream_error";
    try {
      const p = await res.json() as any;
      message = p?.error?.message ?? message;
      upstreamType = p?.error?.type ?? upstreamType;
    } catch {}
    // Claude Code retries 5xx up to ten times, which turns one empty/disengaged
    // M365 turn into a storm of new threads — exactly what the thread-rate
    // throttle counts. Those need a manual retry, so answer them as a
    // non-retryable 400. Real rate limits keep 429 (+ Retry-After).
    const nonRetryable = upstreamType === "upstream_empty_response" || upstreamType === "disengaged";
    const status = nonRetryable ? 400 : res.status;
    const type = nonRetryable ? "invalid_request_error"
      : res.status === 429 ? "rate_limit_error"
      : res.status === 400 ? "invalid_request_error" : "api_error";
    const retryAfter = res.headers.get("Retry-After");
    return anthropicError(status, message, type, retryAfter ? { "Retry-After": retryAfter } : {});
  }
  let payload: unknown;
  try { payload = await res.json(); }
  catch { return anthropicError(502, "M365 upstream returned invalid JSON"); }
  return fromOpenAIChatResponse(payload, body.model, body.stop_sequences);
}

/**
 * Handle an Anthropic Messages request. Streaming is buffered: the M365 turn
 * runs to completion (SSE comment heartbeats keep the socket alive meanwhile),
 * then the whole message is emitted as Anthropic events. Text is not token-live.
 */
export async function handleAnthropicMessages(
  body: AnthropicBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  if (!body.stream) {
    const result = await produce(body, pool, opts.signal);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }

  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {}
      }, 15_000);
      try {
        const result = await produce(body, pool, opts.signal);
        if (result instanceof Response) {
          let error = { type: "api_error", message: "M365 upstream error" };
          try {
            const p = await result.json() as any;
            error = { type: p?.error?.type ?? error.type, message: p?.error?.message ?? error.message };
          } catch {}
          controller.enqueue(enc.encode(sseEvent("error", { type: "error", error })));
        } else {
          controller.enqueue(enc.encode(anthropicSseText(result)));
        }
      } catch (err: any) {
        controller.enqueue(enc.encode(sseEvent("error", { type: "error", error: { type: "api_error", message: err?.message ?? "M365 upstream error" } })));
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** `POST /v1/messages/count_tokens`. An estimate (~4 chars/token): M365 exposes no tokenizer. */
export function estimateAnthropicInputTokens(value: unknown): number {
  let s = "";
  try { s = JSON.stringify(value) ?? ""; } catch { s = String(value); }
  return Math.max(1, Math.ceil(s.length / 4));
}

/** Anthropic Models API shape of `GET /v1/models`, for Claude Code gateway discovery. */
export function buildAnthropicModelsPayload(maxInputTokens: number, maxOutputTokens: number) {
  const data = getAvailableModels().map((id) => ({
    id: `${CLAUDE_GATEWAY_MODEL_PREFIX}${id}`,
    type: "model" as const,
    display_name: id,
    created_at: "1970-01-01T00:00:00Z",
    max_input_tokens: maxInputTokens,
    max_tokens: maxOutputTokens,
  }));
  return { data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null };
}

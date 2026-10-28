import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the OpenAI chat handler with a scripted one: these tests cover only the
// Anthropic ⇄ OpenAI translation, not the M365 turn behind it.
const calls: any[] = [];
let nextResponse: () => Response = () => new Response("{}");
vi.mock("./handler.js", async (importActual) => {
  const actual = await importActual<typeof import("./handler.js")>();
  return {
    ...actual,
    handleChatCompletion: vi.fn(async (body: unknown) => { calls.push(body); return nextResponse(); }),
  };
});

const {
  AnthropicMessagesRequest,
  anthropicSseText,
  fromOpenAIChatResponse,
  resolveM365Model,
  stripM365Markup,
  toOpenAIChatRequest,
} = await import("./anthropic.js");
const { createApp } = await import("./index.js");

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeEach(() => { calls.length = 0; delete process.env.M365_CLAUDE_CODE_MODEL; });

describe("Anthropic → OpenAI request", () => {
  it("translates tools, tool_use and tool_result", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md" }, { type: "text", text: "go on" }] },
      ],
      stream: true,
    });
    const t = toOpenAIChatRequest(body);
    expect(t.stream).toBe(false);
    expect(t.tools?.[0].function.name).toBe("Bash");
    expect(t.tool_choice).toBe("auto");
    expect(t.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "List files" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "toolu_1", name: "Bash", content: "README.md" },
      { role: "user", content: "go on" },
    ]);
  });

  it("merges system-role messages into the system prompt", () => {
    const t = toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "x",
      system: "Top",
      messages: [{ role: "system", content: [{ type: "text", text: "Legacy" }] }, { role: "user", content: "Hi" }],
    }));
    expect(t.messages).toEqual([{ role: "system", content: "Top\n\nLegacy" }, { role: "user", content: "Hi" }]);
  });

  it("turns base64 image blocks (also inside tool results) into image_url parts, rejects URL images", () => {
    const t = toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "x",
      messages: [
        { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }] }] },
      ],
    }));
    expect(t.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] });
    expect(t.messages[2]).toEqual({ role: "tool", tool_call_id: "t1", name: "Read", content: [{ type: "text", text: "[tool error]\n" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }] });
    expect(() => toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "x", messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }],
    }))).toThrow(/base64/);
  });

  it("drops thinking blocks but rejects unknown block types", () => {
    const ok = toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "x",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "b" }] }, { role: "user", content: "c" }],
    }));
    expect(ok.messages[1]).toEqual({ role: "assistant", content: "b" });
    expect(() => toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "x", messages: [{ role: "user", content: [{ type: "server_tool_use", id: "s" }] }],
    }))).toThrow(/server_tool_use/);
  });

  it("maps tool_choice", () => {
    const base = { model: "x", messages: [{ role: "user", content: "a" }], tools: [{ name: "T" }] };
    expect(toOpenAIChatRequest(AnthropicMessagesRequest.parse({ ...base, tool_choice: { type: "any" } })).tool_choice).toBe("required");
    expect(toOpenAIChatRequest(AnthropicMessagesRequest.parse({ ...base, tool_choice: { type: "tool", name: "T" } })).tool_choice)
      .toEqual({ type: "function", function: { name: "T" } });
  });

  it("resolves models: exact id, gateway prefix, env fallback, else schema default", () => {
    expect(resolveM365Model("claude-sonnet-5.5")).toBe("claude-sonnet-5.5");
    expect(resolveM365Model("claude-m365--quick")).toBe("quick");
    expect(resolveM365Model("claude-haiku-4-5-20251001")).toBeUndefined();
    process.env.M365_CLAUDE_CODE_MODEL = "quick";
    expect(resolveM365Model("claude-haiku-4-5-20251001")).toBe("quick");
    delete process.env.M365_CLAUDE_CODE_MODEL;
    const t = toOpenAIChatRequest(AnthropicMessagesRequest.parse({ model: "claude-opus-4-1", messages: [{ role: "user", content: "a" }] }));
    expect(t.model).toBe("gpt-5.5-think-deeper");
  });
});

describe("OpenAI → Anthropic response", () => {
  it("translates tool calls and renders SSE", () => {
    const m = fromOpenAIChatResponse({
      id: "chatcmpl-1",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, x_m365_conversation_pct: 1 },
    }, "claude-sonnet-4-5");
    expect(m.stop_reason).toBe("tool_use");
    expect(m.model).toBe("claude-sonnet-4-5");
    expect(m.content).toEqual([{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "pwd" } }]);
    expect(m.usage).toEqual({ input_tokens: 12, output_tokens: 3, x_m365_conversation_pct: 1 });
    const sse = anthropicSseText(m);
    expect(sse.indexOf("event: message_start")).toBe(0);
    expect(sse).toContain('"type":"input_json_delta"');
    expect(sse.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("applies stop sequences and maps length to max_tokens", () => {
    const m = fromOpenAIChatResponse({ choices: [{ finish_reason: "stop", message: { content: "hello END rest" } }] }, "x", ["END"]);
    expect(m.content).toEqual([{ type: "text", text: "hello " }]);
    expect(m.stop_reason).toBe("stop_sequence");
    expect(m.stop_sequence).toBe("END");
    expect(fromOpenAIChatResponse({ choices: [{ finish_reason: "length", message: { content: "x" } }] }, "x").stop_reason).toBe("max_tokens");
  });
});

describe("createApp /v1/messages", () => {
  const app = createApp();
  const msg = { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

  it("answers a non-streaming request", async () => {
    nextResponse = () => okJson({ id: "c1", choices: [{ finish_reason: "stop", message: { content: "hello" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const res = await app.fetch(post("/v1/messages", msg));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    expect(calls[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("streams the finished message as Anthropic events", async () => {
    nextResponse = () => okJson({ choices: [{ finish_reason: "stop", message: { content: "hello" } }] });
    const res = await app.fetch(post("/v1/messages", { ...msg, stream: true }));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"text_delta","text":"hello"');
    expect(text).toContain("event: message_stop");
  });

  it("answers disengaged/empty turns as non-retryable 400s, keeps 429", async () => {
    nextResponse = () => new Response(JSON.stringify({ error: { type: "disengaged", message: "Disengaged" } }), { status: 502 });
    let res = await app.fetch(post("/v1/messages", msg));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request_error");

    nextResponse = () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "Retry-After": "30" } });
    res = await app.fetch(post("/v1/messages", msg));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(((await res.json()) as any).error.type).toBe("rate_limit_error");
  });

  it("sends a stream error as an SSE error event", async () => {
    nextResponse = () => new Response(JSON.stringify({ error: { type: "upstream_error", message: "boom" } }), { status: 502 });
    const text = await (await app.fetch(post("/v1/messages", { ...msg, stream: true }))).text();
    expect(text).toContain("event: error");
    expect(text).toContain("boom");
  });

  it("rejects unsupported content with a 400 without calling M365", async () => {
    const res = await app.fetch(post("/v1/messages", { ...msg, messages: [{ role: "user", content: [{ type: "server_tool_use", id: "s" }] }] }));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("estimates count_tokens and lists models in Anthropic shape for Anthropic clients", async () => {
    const ct = await (await app.fetch(post("/v1/messages/count_tokens", msg))).json() as any;
    expect(ct.input_tokens).toBeGreaterThan(0);

    const anth = await (await app.fetch(new Request("http://localhost/v1/models", { headers: { "anthropic-version": "2023-06-01" } }))).json() as any;
    expect(anth.data[0].id.startsWith("claude-m365--")).toBe(true);
    expect(anth.data[0].type).toBe("model");
    const oai = await (await app.fetch(new Request("http://localhost/v1/models"))).json() as any;
    expect(oai.object).toBe("list");
    expect(oai.data[0].id.startsWith("claude-m365--")).toBe(false);
  });
});

describe("stripM365Markup", () => {
  const [S, M, E] = [0xe200, 0xe202, 0xe201].map((c) => String.fromCharCode(c));
  it("drops citation markers and unwraps <File> chips", () => {
    expect(stripM365Markup(`Read <File>App.sln</File> fine. cite${M}turn0file1${E}`.replace("cite", `${S}cite`)))
      .toBe("Read App.sln fine.");
    expect(stripM365Markup("no markup here")).toBe("no markup here");
  });
  it("is applied to text blocks but not to tool inputs", () => {
    const m = fromOpenAIChatResponse({ choices: [{ finish_reason: "tool_calls", message: {
      content: `see <File>a.txt</File>${S}cite${M}x${E}`,
      tool_calls: [{ id: "c", function: { name: "Write", arguments: JSON.stringify({ content: "<File>keep</File>" }) } }],
    } }] }, "x");
    expect(m.content[0]).toEqual({ type: "text", text: "see a.txt" });
    expect((m.content[1] as any).input).toEqual({ content: "<File>keep</File>" });
  });
});

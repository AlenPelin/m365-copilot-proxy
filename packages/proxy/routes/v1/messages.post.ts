import { AnthropicMessagesRequest, handleAnthropicMessages } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";

/** Anthropic Messages API, for Claude Code and Anthropic SDK clients (proxy-lib anthropic.ts). */
export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof AnthropicMessagesRequest.parse>;
  try {
    body = AnthropicMessagesRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Same premature-close → abort wiring as chat/completions.post.ts.
  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  return handleAnthropicMessages(body, pool, { signal: ac.signal });
});

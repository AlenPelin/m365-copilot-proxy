import { estimateAnthropicInputTokens } from "@m365-copilot/proxy-lib";

/** Claude Code calls this for context planning. An estimate: M365 exposes no tokenizer. */
export default defineEventHandler(async (event) => ({
  input_tokens: estimateAnthropicInputTokens(await readBody(event)),
}));

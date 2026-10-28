import { buildClaudeModelsPayload, buildModelsPayload, wantsAnthropicModels } from "@m365-copilot/proxy-lib";

// Anthropic clients (Claude Code gateway discovery) get the Anthropic Models API
// shape; everyone else the OpenAI list.
export default defineEventHandler((event) =>
  wantsAnthropicModels((name) => getHeader(event, name)) ? buildClaudeModelsPayload() : buildModelsPayload(),
);

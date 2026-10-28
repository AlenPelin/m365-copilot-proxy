import { timingSafeEqual } from "node:crypto";

/**
 * Optional API key for the `/v1/*` routes (adapted from the NightMean fork's
 * api-auth.ts). Off unless M365_PROXY_API_KEY is set, so existing setups keep
 * working. Accepts the key as `Authorization: Bearer <key>` (OpenAI clients,
 * Claude Code's ANTHROPIC_AUTH_TOKEN) or `x-api-key` (Anthropic SDK,
 * ANTHROPIC_API_KEY). `GET /v1/models` stays open: it is a static list.
 */
export default defineEventHandler((event) => {
  const expected = process.env.M365_PROXY_API_KEY;
  if (!expected) return;
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/v1/") || event.method === "OPTIONS") return;
  if (event.method === "GET" && path === "/v1/models") return;

  const want = Buffer.from(expected);
  const given = [getHeader(event, "authorization")?.replace(/^Bearer\s+/i, ""), getHeader(event, "x-api-key")]
    .filter((v): v is string => !!v)
    .map((v) => Buffer.from(v.trim()));
  if (!given.some((g) => g.length === want.length && timingSafeEqual(g, want))) {
    throw createError({ statusCode: 401, statusMessage: "Invalid proxy API key" });
  }
});

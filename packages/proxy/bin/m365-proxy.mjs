#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
// Binds to 127.0.0.1 unless $HOST / $NITRO_HOST say otherwise: Nitro alone would
// listen on every interface, handing the M365 account to anyone on the network.
// Sets M365_FORCE_AGENT=0 unless it is already set (see below).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);
if (!process.env.NITRO_HOST && !process.env.HOST) process.env.NITRO_HOST = "127.0.0.1";

// No Copilot Studio tool agent unless asked for: publishing it needs "Copilot
// extensibility", which basic accounts lack (403), and every attempt touches bots
// in the tenant. M365_FORCE_AGENT=1 forces it on; =auto restores the per-model
// choice (core toolRequestUsesAgent).
if (process.env.M365_FORCE_AGENT === undefined) process.env.M365_FORCE_AGENT = "0";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

await import(pathToFileURL(entry).href);

#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
// Binds to 127.0.0.1 unless $HOST / $NITRO_HOST say otherwise: Nitro alone would
// listen on every interface, handing the M365 account to anyone on the network.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);
if (!process.env.NITRO_HOST && !process.env.HOST) process.env.NITRO_HOST = "127.0.0.1";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

await import(pathToFileURL(entry).href);

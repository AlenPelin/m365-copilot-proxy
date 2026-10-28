#!/usr/bin/env node
// Egress guard for Claude Code (used by scripts/claude-local.sh / .ps1).
//
//   node scripts/claude-guard.mjs <command> [args...]
//
// Starts a local HTTP(S) proxy, runs <command> with HTTPS_PROXY/HTTP_PROXY pointing
// at it (NO_PROXY only for localhost, so the M365 proxy is reached directly), and:
//   - refuses any connection to a blocked host (Anthropic by default) — no DNS
//     lookup, no TCP connection, nothing leaves the machine — and on that FIRST
//     attempt kills <command> (whole process tree) and exits with code 99;
//   - passes every other host through, so tools the agent runs (npm, git, curl
//     from Bash — they inherit the proxy env) still work.
//
// Env:
//   CLAUDE_GUARD_BLOCK   comma-separated domains to block (a domain also blocks its
//                        subdomains). Default: anthropic.com,claude.ai,claude.com
//   CLAUDE_GUARD_LOG     file to append every connection (allowed/blocked) to
//
// Limit: this works because Claude Code (and most CLI tools) honour HTTPS_PROXY.
// A program that ignores proxy env vars would bypass it; only an OS firewall rule
// stops that.
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const BLOCK = (process.env.CLAUDE_GUARD_BLOCK ?? "anthropic.com,claude.ai,claude.com")
  .split(",").map((d) => d.trim().toLowerCase().replace(/^\.+/, "")).filter(Boolean);
const LOG = process.env.CLAUDE_GUARD_LOG;
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/claude-guard.mjs <command> [args...]");
  process.exit(2);
}

function isBlocked(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return BLOCK.some((d) => h === d || h.endsWith(`.${d}`));
}

function log(kind, target) {
  if (!LOG) return;
  try { appendFileSync(LOG, `${new Date().toISOString()} ${kind} ${target}\n`); } catch {}
}

let child = null;
let tripped = false;

function killTree() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    // Not detached (a detached child loses the terminal), so kill its children
    // (e.g. a running Bash tool) first, then it. Then undo the TUI's raw mode.
    spawnSync("pkill", ["-KILL", "-P", String(child.pid)], { stdio: "ignore" });
    try { child.kill("SIGKILL"); } catch {}
    spawnSync("stty", ["sane"], { stdio: "inherit" });
  }
}

function trip(host) {
  if (tripped) return;
  tripped = true;
  // stderr, after the TUI dies: say what happened.
  setTimeout(() => {
    process.stderr.write(`\n[claude-guard] BLOCKED a connection to ${host} — stopped Claude Code. Nothing was sent.\n`);
  }, 50);
  killTree();
  setTimeout(() => process.exit(99), 300);
}

const server = http.createServer((req, res) => {
  // Plain-HTTP proxy request: absolute URL in req.url.
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  if (isBlocked(url.hostname)) {
    log("BLOCKED", url.host);
    res.writeHead(403).end("blocked by claude-guard");
    trip(url.hostname);
    return;
  }
  log("ALLOW", url.host);
  const up = http.request(url, { method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { try { res.writeHead(502).end(); } catch {} });
  req.pipe(up);
});

server.on("connect", (req, socket, head) => {
  // HTTPS: "CONNECT host:port". Decide on the hostname before any lookup.
  const [host, port = "443"] = String(req.url).replace(/^\[|\](?=:)/g, "").split(/:(?=\d+$)/);
  if (isBlocked(host)) {
    log("BLOCKED", req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    trip(host);
    return;
  }
  log("ALLOW", req.url);
  const up = net.connect(Number(port), host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(0, "127.0.0.1", () => {
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  // Replace (not merge) any inherited proxy settings: an inherited NO_PROXY could
  // otherwise exempt an Anthropic host from the guard.
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  Object.assign(env, {
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
  });
  log("START", `${proxy} block=${BLOCK.join(",")}`);
  child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("error", (e) => { console.error(`[claude-guard] cannot start ${cmd}: ${e.message}`); process.exit(127); });
  child.on("exit", (code, signal) => {
    if (tripped) return; // trip() exits with 99
    server.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
});

// Ctrl+C reaches the child directly (same console); don't die before it does.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});

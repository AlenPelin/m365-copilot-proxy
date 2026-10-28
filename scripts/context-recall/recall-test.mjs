// Context-recall probe for one M365 model through the local proxy (no tools).
// Turn 1 sends a rule + a fact + ~40 messages of filler history in ONE request
// (proxy "full" mode, like a resumed session); turns 2..N append ~25 KB "tool
// outputs" (proxy "delta" mode); the last turns ask what was planted.
//   node recall-test.mjs <repoDir> <outFile> [model]
import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [repo, out, model = "gpt-6.1-sol"] = process.argv.slice(2);
const URL_ = `http://127.0.0.1:${process.env.PORT || 4141}/v1/chat/completions`;
const log = (s) => { appendFileSync(out, s + "\n"); console.log(s); };

// Benign, varied filler: this repo's own TypeScript source (like real tool output).
function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (/node_modules|dist|\.output|\.nitro/.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) acc.push(p);
  }
  return acc;
}
const src = walk(join(repo, "packages")).map((p) => readFileSync(p, "utf8")).join("\n\n");
let cursor = 0;
const chunk = (n) => { const s = src.slice(cursor, cursor + n); cursor = (cursor + n) % (src.length - n); return s; };

const RULE = "House rule for this whole session: end EVERY reply with the exact token ZEBRA-17 on its own line.";
const FACT = (process.env.RUN_TAG ? process.env.RUN_TAG + ". " : "") + "Remember this for later: the project codename is BLUE-HERON-482.";
const MID = "Side note to remember: the staging database port is 6413.";

const messages = [{ role: "system", content: RULE }, { role: "user", content: FACT }, { role: "assistant", content: "Noted.\nZEBRA-17" }];
for (let i = 0; i < 20; i++) {
  messages.push({ role: "user", content: `File ${i + 1} of a code review, just acknowledge:\n\n${chunk(6000)}` });
  messages.push({ role: "assistant", content: `Reviewed file ${i + 1}.\nZEBRA-17` });
  if (i === 10) {
    messages.push({ role: "user", content: MID });
    messages.push({ role: "assistant", content: "Noted.\nZEBRA-17" });
  }
}

async function ask(content, label) {
  messages.push({ role: "user", content });
  const chars = JSON.stringify(messages).length;
  const t0 = Date.now();
  const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: false }) });
  const j = await r.json().catch(() => ({}));
  const text = j?.choices?.[0]?.message?.content ?? `[HTTP ${r.status}] ${JSON.stringify(j).slice(0, 200)}`;
  messages.push({ role: "assistant", content: text });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  log(`--- ${label} | history ${messages.length - 1} msgs, ~${Math.round(chars / 4 / 1000)}k tokens | ${s}s | rule kept: ${/ZEBRA-17\s*$/.test(text.trim())}`);
  log(text.trim().slice(0, 300).replace(/\n/g, " / "));
  return text;
}

log(`model=${model} started ${new Date().toISOString()}`);
await ask("Quick check: what is the project codename? One line.", "T1 full history (planted at msg 2)");
for (let i = 0; i < 9; i++) {
  await ask(`Tool output ${i + 1} (build log / source dump), just reply "ok":\n\n${chunk(25000)}`, `T${i + 2} filler`);
}
await ask("What is the project codename, and what is the staging database port? One line.", "T11 recall both facts");
await ask("Repeat the house rule from the very start of this session, word for word.", "T12 recall the rule itself");
log(`finished ${new Date().toISOString()}`);

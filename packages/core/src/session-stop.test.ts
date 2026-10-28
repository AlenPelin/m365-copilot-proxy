import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

// A scripted stand-in for the `ws` WebSocket: the test plays the server's frames.
const sockets: FakeWebSocket[] = [];
class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  constructor() {
    super();
    sockets.push(this);
    setImmediate(() => this.emit("open"));
  }
  send(data: string) { this.sent.push(data); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  /** Deliver one server frame. */
  recv(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame) + "\x1E")); }
}
vi.mock("ws", () => ({ default: FakeWebSocket }));

const { CopilotSession } = await import("./session.js");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ aud: "a", iss: "i", oid: "o", tid: "t", exp: 9_999_999_999 })}.sig`;
const tick = () => new Promise((r) => setImmediate(r));
const delta = (text: string) => ({ type: 1, target: "update", arguments: [{ writeAtCursor: text }] });

describe("CopilotSession — nothing is kept after the Stop frame", () => {
  it("drops the text M365 sends after Stop (\"You have stopped this conversation.\")", async () => {
    const ac = new AbortController();
    const session = new CopilotSession();
    const pending = session.chat(TOKEN, "hi", "m365-copilot", ac.signal);
    await tick();
    const ws = sockets.at(-1)!;
    ws.recv({}); // handshake ack
    const stream = await pending;
    const got: string[] = [];
    const reading = (async () => { for await (const d of stream) got.push(d); })();

    ws.recv(delta("```bash\nls\n```"));
    await tick();
    ac.abort(); // the client left, or the handler's early stop fired
    expect(ws.sent.some((s) => s.includes('"target":"stop"'))).toBe(true);

    // M365 keeps talking for a moment after the Stop.
    ws.recv(delta("\n\nYou have stopped this conversation."));
    ws.recv({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: "```bash\nls\n```\n\nYou have stopped this conversation." }] }] });
    ws.recv({ type: 3, invocationId: "0" });
    await reading;

    expect(got.join("")).toBe("```bash\nls\n```");
    expect(stream.fullText).toBe("```bash\nls\n```");
  });
});

describe("CopilotSession — initialTurnCount (a reconnect into a conversation M365 has)", () => {
  async function sentStart(session: InstanceType<typeof CopilotSession>): Promise<boolean> {
    const pending = session.chat(TOKEN, "hi", "m365-copilot");
    await tick();
    const ws = sockets.at(-1)!;
    ws.recv({});
    await pending;
    ws.recv({ type: 3, invocationId: "0" });
    const chat = ws.sent.find((s) => s.includes('"target":"chat"'))!;
    return JSON.parse(chat.split("\x1E")[0]).arguments[0].isStartOfSession;
  }

  it("sends the first turn as the start of the conversation by default", async () => {
    expect(await sentStart(new CopilotSession())).toBe(true);
  });

  it("doesn't when the conversation already has turns", async () => {
    const session = new CopilotSession({ initialTurnCount: 3 });
    expect(await sentStart(session)).toBe(false);
    expect(session.turnCount).toBe(4);
  });
});

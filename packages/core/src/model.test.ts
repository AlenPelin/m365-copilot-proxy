import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnBudgetHold } from "./turn-budget.js";

// ModelSession.run's reconnect: when the first chat() fails it sends the turn
// again on a fresh CopilotSession, and that turn waits on the budget like any
// other (#77). The CopilotSession is faked: each chat() is one upstream turn.
// `starts` records, per chat(), whether it went out as the conversation's first
// turn (isStartOfSession), as the real CopilotSession decides it.
const wire = vi.hoisted(() => ({ events: [] as string[], failures: 0, starts: [] as boolean[] }));

vi.mock("./session.js", () => ({
  CopilotSession: class {
    turnCount = 0;
    constructor(options?: { initialTurnCount?: number }) {
      this.turnCount = options?.initialTurnCount ?? 0;
    }
    chat(token: string) {
      wire.starts.push(this.turnCount === 0);
      this.turnCount++;
      wire.events.push(`chat:${token}`);
      if (wire.failures > 0) {
        wire.failures--;
        return Promise.reject(new Error("WebSocket error: connection failed"));
      }
      return Promise.resolve({ fullText: "ok" });
    }
  },
}));

const { ModelSession } = await import("./model.js");

function session() {
  let n = 0;
  return new ModelSession({ getToken: async () => `tok${++n}` });
}

afterEach(() => {
  wire.events = [];
  wire.failures = 0;
  wire.starts = [];
});

describe("ModelSession.run's reconnect", () => {
  it("waits on the turn budget before it sends the turn again, with a fresh token after a wait", async () => {
    wire.failures = 1;
    const waitForBudget = async () => { wire.events.push("wait"); return { waitedMs: 30_000 }; };
    await session().run("hi", "claude-sonnet", undefined, [], waitForBudget);
    expect(wire.events).toEqual(["chat:tok1", "wait", "chat:tok2"]);
  });

  it("keeps the token when the budget let it through at once", async () => {
    wire.failures = 1;
    const waitForBudget = async () => { wire.events.push("wait"); return { waitedMs: 0 }; };
    await session().run("hi", "claude-sonnet", undefined, [], waitForBudget);
    expect(wire.events).toEqual(["chat:tok1", "wait", "chat:tok1"]);
  });

  it("doesn't send it when the budget refuses the turn", async () => {
    wire.failures = 1;
    const hold = new TurnBudgetHold("refill", 5 * 60_000, null);
    const waitForBudget = async () => { throw hold; };
    await expect(session().run("hi", "claude-sonnet", undefined, [], waitForBudget)).rejects.toBe(hold);
    expect(wire.events).toEqual(["chat:tok1"]);
  });

  it("doesn't wait again when the first turn goes through", async () => {
    const waitForBudget = vi.fn(async () => ({ waitedMs: 0 }));
    await session().run("hi", "claude-sonnet", undefined, [], waitForBudget);
    expect(waitForBudget).not.toHaveBeenCalled();
    expect(wire.events).toEqual(["chat:tok1"]);
  });

  it("waits with awaitTurnBudget by default (a no-op unless M365_AVOID_THROTTLING is set)", async () => {
    const saved = process.env.M365_AVOID_THROTTLING;
    delete process.env.M365_AVOID_THROTTLING;
    try {
      wire.failures = 1;
      await session().run("hi", "claude-sonnet", undefined);
      expect(wire.events).toEqual(["chat:tok1", "chat:tok1"]);
    } finally {
      if (saved !== undefined) process.env.M365_AVOID_THROTTLING = saved;
    }
  });
});

// After a reconnect the turn count came from the fresh CopilotSession, so it fell
// to 0: the reconnect's turn went out as isStartOfSession:true into a conversation
// M365 already had (idea from Bertogim 48fbe71).
describe("ModelSession.run's reconnect keeps the conversation's turn count", () => {
  it("doesn't send the reconnect's turn as the start of the conversation", async () => {
    const model = session();
    await model.run("task", "claude-sonnet", undefined, []);
    await model.run("result 1", "claude-sonnet", undefined, []);
    wire.failures = 1;
    await model.run("result 2", "claude-sonnet", undefined, []);
    expect(wire.starts).toEqual([true, false, false, false]);
    expect(model.turnCount).toBe(3);
  });

  it("sends it as the start when the first turn is the one that failed (it never reached M365)", async () => {
    const model = session();
    wire.failures = 1;
    await model.run("task", "claude-sonnet", undefined, []);
    expect(wire.starts).toEqual([true, true]);
    expect(model.turnCount).toBe(1);
  });

  it("starts from 0 again in a new conversation", async () => {
    const model = session();
    await model.run("task", "claude-sonnet", undefined, []);
    model.newConversation();
    expect(model.turnCount).toBe(0);
    await model.run("task", "claude-sonnet", undefined, []);
    expect(wire.starts).toEqual([true, true]);
  });
});

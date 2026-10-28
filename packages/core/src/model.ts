import { getToken } from "./auth.js";
import { CopilotSession } from "./session.js";
import { uploadImage, type ImageAnnotation } from "./image-input.js";
import { createLogger, trunc } from "./log.js";
import { awaitTurnBudget } from "./turn-budget.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /**
   * Prevent proxy conversations appearing in the M365 Copilot history sidebar.
   * Defaults to true. Set false only when persistent Copilot history is wanted.
   */
  temporaryChat?: boolean;
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across CopilotSession
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private temporaryChat: boolean;
  private copilotSession: CopilotSession | null = null;

  /** Stable IDs reused across CopilotSession reconnections. */
  readonly sessionId: string = crypto.randomUUID();
  private _conversationId: string = crypto.randomUUID();
  /** Current M365 ConversationId (the throttle/Disengage state keys on this). */
  get conversationId(): string { return this._conversationId; }
  /**
   * Rotate to a FRESH conversation. A conversation that has Disengaged appears to
   * STAY Disengaged (a clean retry in the same conversation kept refusing), so the
   * Disengage-recovery retry needs a new ConversationId, not just a different prompt.
   * See docs §10 F22.
   */
  newConversation(): void {
    this._conversationId = crypto.randomUUID();
    this.reset();
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.temporaryChat =
      options.temporaryChat ?? process.env.M365_SAVE_HISTORY !== "1";
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? 0;
  }

  private createCopilotSession(): CopilotSession {
    return new CopilotSession({
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      temporaryChat: this.temporaryChat,
    });
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * If `signal` aborts (the HTTP client disconnects) the in-flight turn is
   * cancelled by sending M365's Stop frame, mirroring the real UI's Stop button.
   *
   * `waitForBudget` waits until the account's turn budget can afford one more
   * turn (M365_AVOID_THROTTLING; awaitTurnBudget). The caller waits before it
   * calls run(); run() waits again before the reconnect's turn. It throws
   * TurnBudgetHold rather than wait too long.
   */
  async run(
    text: string,
    model: string = "m365-copilot",
    signal?: AbortSignal,
    images: string[] = [],
    waitForBudget: () => Promise<{ waitedMs: number }> = () => awaitTurnBudget({ signal }),
  ): Promise<CopilotStream> {
    let token = await this.resolveToken();
    // Image input (#39): upload each image for this conversation; the message points at them.
    // A failed upload is said in the text, so the model doesn't answer about an image it never got.
    const annotations: ImageAnnotation[] = [];
    for (const url of images) {
      try {
        annotations.push(await uploadImage(token, this.conversationId, url));
      } catch (err: any) {
        log.info(`Image upload failed: ${err.message}`);
        text += `

(Note: an attached image could not be passed on — ${err.message.slice(0, 120)}. Don't describe it; say it didn't arrive.)`;
      }
    }
    if (!this.copilotSession) this.copilotSession = this.createCopilotSession();

    log.info(`run: model=${model}, turn=${this.copilotSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(trunc(text, 200))}`);

    // Match the GUI: image gen is always available, so a plain "draw me an image"
    // produces one with no special mode (§14). Opt out with M365_NO_IMAGE_GEN.
    const turnOpts = { generateImages: !process.env.M365_NO_IMAGE_GEN, images: annotations };

    try {
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    } catch (err: any) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
      // The reconnect is one more upstream turn, so it waits on the budget too:
      // otherwise it skips the wait and its recordTurn takes the grant of a turn
      // another request was let through for (#77). A token held through a long
      // wait may be near its end, so fetch it again.
      if ((await waitForBudget()).waitedMs > 0) token = await this.resolveToken();
      this.copilotSession = this.createCopilotSession();
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    }
  }

  /**
   * Reset the CopilotSession. Next run() reconnects with the same
   * sessionId/conversationId.
   */
  reset() {
    this.copilotSession = null;
  }
}

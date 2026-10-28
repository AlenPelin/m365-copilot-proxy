import * as msal from "@azure/msal-node";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

// Generated-image bytes live on designerapp.officeapps.live.com behind SharePoint
// Embedded (§14). The Sydney token 401s there; the artifact wants a token for the
// designerapp *service*. Our own first-party client IS preauthorized for it (the
// web client mints it via refresh_token), so acquireTokenSilent works — confirmed
// fetching a 2.3 MB PNG. Note it's an RSA-OAEP JWE, opaque to us; we pass it through.
const IMAGE_ARTIFACT_SCOPES = [
  "https://designerappservice.officeapps.live.com/.default",
];

/** Token that authorizes fetching a generated-image artifact URL (§14). Silent
 *  from the cached refresh token; falls back to the same sign-in window as chat. */
export function getImageArtifactToken(): Promise<string | null> {
  return getTokenForScope(IMAGE_ARTIFACT_SCOPES);
}

import { createLogger } from "./log.js";
const log = createLogger("auth");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

function resolveFile(envVar: string, defaultName: string): string {
  if (process.env[envVar]) return process.env[envVar]!;
  mkdirSync(CONFIG_DIR, { recursive: true });
  return join(CONFIG_DIR, defaultName);
}

const CACHE_FILE = resolveFile("M365_CACHE_FILE", "msal-cache.json");
// The old stored-credentials login (email/password/TOTP) is gone: sign-in is
// interactive only. A leftover secrets.json still holds a plain-text password, so
// say once that it is unused and can be deleted.
const OLD_SECRETS_FILE = process.env.M365_SECRETS_FILE ?? join(CONFIG_DIR, "secrets.json");
let warnedOldSecrets = false;
function warnOldSecrets(): void {
  if (warnedOldSecrets || !existsSync(OLD_SECRETS_FILE)) return;
  warnedOldSecrets = true;
  console.error(
    `[m365 auth] ${OLD_SECRETS_FILE} is no longer used (sign-in is interactive only). It holds your password in plain text — delete it.`,
  );
}

// Browser identity for the sign-in window. These defaults are the §11 F25
// anti-fingerprint config — empirically tuned against AAD's bot scoring for the
// account this was built on, hence overridable rather than derived: a wrong
// locale is cosmetic, but silently changing a fingerprint that currently passes
// is not worth the risk.
const LOGIN_LOCALE = process.env.M365_LOGIN_LOCALE ?? "en-GB";
const LOGIN_TIMEZONE = process.env.M365_LOGIN_TIMEZONE ?? "Europe/Copenhagen";

/** M365_NO_INTERACTIVE=1 vetoes the sign-in window, so a headless host (systemd,
 *  CI) fails loudly instead of waiting on a window nobody can see. */
function interactiveAllowed(): boolean {
  return process.env.M365_NO_INTERACTIVE !== "1";
}

function interactiveTimeoutMs(): number {
  const raw = Number(process.env.M365_INTERACTIVE_TIMEOUT_MS ?? 600_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}

// --- MSAL cache persistence ---

function loadCache(app: msal.PublicClientApplication) {
  if (existsSync(CACHE_FILE)) {
    try {
      app.getTokenCache().deserialize(readFileSync(CACHE_FILE, "utf-8"));
    } catch {}
  }
}

function saveCache(app: msal.PublicClientApplication) {
  try {
    // Holds refresh tokens: owner-only (no effect on Windows, which uses the profile ACL).
    writeFileSync(CACHE_FILE, app.getTokenCache().serialize(), { mode: 0o600 });
    chmodSync(CACHE_FILE, 0o600); // mode above only applies to a new file
  } catch {}
}

let _app: msal.PublicClientApplication | null = null;

function getApp(): msal.PublicClientApplication {
  if (!_app) {
    _app = new msal.PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
    loadCache(_app);
  }
  return _app;
}

// --- PKCE helpers ---

async function buildAuthUrlForScopes(app: msal.PublicClientApplication, scopes: string[]) {
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const authUrl = await app.getAuthCodeUrl({
    scopes,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });

  return { authUrl, verifier };
}

// --- Sign-in browser ---

const LOGIN_DEBUG_DIR = join(CONFIG_DIR, "login-debug");

// A PERSISTENT browser profile is the biggest anti-detection lever (docs/hypotheses.md
// §11, H-R3). It keeps the AAD session cookies (`ESTSAUTH*`) and device cookie across
// runs, so after the first login subsequent ones are SSO-silent (no password/TOTP page)
// AND present as a *returning familiar device* — which is exactly what Entra ID's risk
// engine scores as low-risk. A fresh ephemeral context (the old behaviour) looked like a
// brand-new unfamiliar device on every single login. Override with M365_BROWSER_PROFILE.
const BROWSER_PROFILE_DIR = resolveFile("M365_BROWSER_PROFILE", "browser-profile");

// A coherent, non-headless-looking UA that MATCHES the platform we actually run on
// (Linux). The default headless Chromium advertises `HeadlessChrome/<v>` in both
// navigator.userAgent AND the HTTP User-Agent header — a direct "I'm a bot" tell that
// login.microsoftonline.com's device-fingerprinting reads. We override it at the context
// level (fixes both layers). Deliberately NOT spoofing a different OS: a Windows UA on a
// Linux navigator.platform is itself an incoherent, flaggable fingerprint (F25 Config-B).
const LOGIN_USER_AGENT =
  process.env.M365_LOGIN_UA ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/**
 * Resolve a usable Chromium executable. Playwright's bundled chrome-headless-shell
 * is not patched for NixOS (fails on libglib-2.0.so.0), so prefer an explicit
 * CHROMIUM_PATH, then a system chromium on PATH. Returns undefined to let
 * Playwright use its bundled browser (works on patched/standard distros).
 */
function resolveChromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    try {
      const found = execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) {
        log.info(`Resolved system browser: ${found}`);
        return found;
      }
    } catch {
      // not on PATH, try next
    }
  }
  return undefined;
}

async function capture(page: any, label: string): Promise<void> {
  try {
    mkdirSync(LOGIN_DEBUG_DIR, { recursive: true });
    await page.screenshot({
      path: join(LOGIN_DEBUG_DIR, `${label}.png`),
      fullPage: true,
    });
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.html`), await page.content());
    // Write the URL unconditionally (independent of the debug-log flag).
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.url.txt`), page.url());
    log.info(`Captured ${label} — url: ${page.url()}`);
  } catch (e: any) {
    log.error(`Failed to capture ${label}: ${e?.message}`);
  }
}

// --- Token acquisition methods ---

export async function getTokenSilent(): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({
      scopes: SCOPES,
      account: accounts[0],
    });
    saveCache(app);
    return result.accessToken;
  } catch {
    return null;
  }
}

/**
 * The only sign-in path (§13). Works with any MFA your tenant enforces — TOTP,
 * push/number matching, FIDO2, Windows Hello, Okta/Ping/Duo federation — because a
 * human completes it; the proxy never sees or stores a password or MFA secret.
 *
 * Opens a VISIBLE browser, lets a human complete SSO/MFA once, then captures the
 * code and exchanges it with PKCE. Afterwards the persistent profile plus the MSAL
 * refresh token make subsequent starts silent — the window is a one-time cost.
 *
 * Adapted from @EatonWu's fork (github.com/EatonWu/m365-copilot-proxy).
 *
 * Why this redirect and not a loopback port: the client is Microsoft's own app, so
 * nobody in the loop — not us, not your tenant admin — can register a new redirect
 * URI. A generated `http://localhost:<port>` callback is rejected with AADSTS50011
 * (H13.1, live). `nativeclient` is already registered, so it is the only door.
 *
 * Device code is NOT an alternative: initiation succeeds but redemption demands a
 * `client_secret` we can never hold (H13.2, AADSTS7000218, live). Don't re-add it.
 */
async function loginInteractiveForScopes(scopes: string[]): Promise<string> {
  if (!interactiveAllowed()) {
    throw new Error("Interactive login is disabled (M365_NO_INTERACTIVE=1)");
  }
  const { chromium } = await import("playwright");
  const app = getApp();
  const timeoutMs = interactiveTimeoutMs();
  const { authUrl, verifier } = await buildAuthUrlForScopes(app, scopes);

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false, // the entire point: a human has to see and drive this
    executablePath: resolveChromiumPath(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
    userAgent: LOGIN_USER_AGENT,
    locale: LOGIN_LOCALE,
    timezoneId: LOGIN_TIMEZONE,
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // The nativeclient redirect URI is meant for embedded native hosts to intercept;
  // a real browser follows it one hop further to /common/wrongplace, so the ?code=
  // only exists on the navigation request. Capture it there.
  let resolveCode: (code: string) => void;
  const codePromise = new Promise<string>((res) => {
    resolveCode = res;
  });
  page.on("request", (req: any) => {
    const u = req.url();
    if (u.includes("/oauth2/nativeclient") && u.includes("code=")) {
      const c = new URL(u).searchParams.get("code");
      if (c) {
        log.info("Captured auth code from nativeclient redirect (interactive)");
        resolveCode(c);
      }
    }
  });

  try {
    // console.error, not log: this is a blocking instruction to a human and must
    // appear even with debug logging off, or the proxy looks hung.
    console.error("[m365 auth] Interactive approval required.");
    console.error("[m365 auth] A browser window has opened — complete sign-in there.");
    console.error(`[m365 auth] Waiting up to ${Math.round(timeoutMs / 1000)}s.`);
    await page.goto(authUrl, { waitUntil: "domcontentloaded" });
    // Promise.race doesn't cancel the loser, so the timer must be cleared by hand:
    // a 10-minute pending setTimeout keeps Node's event loop alive long after a
    // successful login, and any script calling getToken() would hang instead of
    // exiting (observed: EXIT=124, one lingering "Timeout" handle).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const authCode = await Promise.race([
      codePromise,
      new Promise<string>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`Timed out waiting for interactive auth code after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    const result = await app.acquireTokenByCode({
      code: authCode,
      scopes,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
    });
    saveCache(app);
    log.info(`Interactive login succeeded as ${result.account?.username}`);
    // Pairs with the "Waiting up to …" line above; without it the proxy looks hung.
    console.error(`[m365 auth] Signed in as ${result.account?.username ?? "unknown"} — token saved, browser closing.`);
    return result.accessToken;
  } catch (err: any) {
    await capture(page, "interactive-fail");
    throw err;
  } finally {
    await context.close();
  }
}

// Ensure we hold a usable token. Retained as a MANUAL lever only — nothing auto-invokes
// it anymore (see auth-recovery.ts: degradation is handled by backoff, not re-login).
//
// It used to force a fresh login on the F13 belief that new tokens clear throttle.
// They don't (H-R1 / API doc §2/§7: throttle is `oid`-keyed, and a regenerated token
// carries the same `oid`). So: silent refresh first (invisible, no login page), and
// open the sign-in window ONLY if silent genuinely can't produce a token.
// Single-flight so concurrent callers share one refresh.
let inflightReauth: Promise<boolean> | null = null;

export function forceReauth(): Promise<boolean> {
  return (inflightReauth ??= doForceReauth().finally(() => {
    inflightReauth = null;
  }));
}

async function doForceReauth(): Promise<boolean> {
  try {
    const silent = await getTokenSilent();
    if (silent) {
      log.info("forceReauth: refreshed silently — no interactive login needed");
      return true;
    }
    log.info("forceReauth: silent unavailable, asking for interactive sign-in");
    await loginInteractiveForScopes(SCOPES);
    return true;
  } catch (err: any) {
    log.error(`forceReauth failed: ${err.message}`);
    return false;
  }
}

export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  log.info(`getTokenForScope: ${scopes.join(",")} — ${accounts.length} accounts in cache`);

  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({
        scopes,
        account: accounts[0],
      });
      saveCache(app);
      return result.accessToken;
    } catch (err: any) {
      log.info(`getTokenForScope: silent failed (${err.message}), trying interactive sign-in`);
    }
  }

  // Silent unavailable — a human signs in (§13), unless M365_NO_INTERACTIVE=1.
  if (!interactiveAllowed()) return null;
  return loginInteractiveForScopes(scopes);
}

// Serialize token acquisition: concurrent callers share one in-flight login
// instead of opening several sign-in windows for the same account.
let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  return (inflightToken ??= doGetToken().finally(() => {
    inflightToken = null;
  }));
}

async function doGetToken(): Promise<string> {
  warnOldSecrets();
  const silent = await getTokenSilent();
  if (silent) {
    log.info("Token refreshed silently");
    return silent;
  }

  // Sign-in is interactive only: a visible browser window where you complete
  // SSO/MFA yourself. A headless host (systemd, CI) sets M365_NO_INTERACTIVE=1 to
  // fail loudly rather than wait on a window nobody can see (§13).
  if (!interactiveAllowed()) {
    throw new Error(
      "No usable cached token and interactive sign-in is disabled (M365_NO_INTERACTIVE=1). Sign in once on a machine with a display (start the proxy there), then copy msal-cache.json to this host.",
    );
  }
  return loginInteractiveForScopes(SCOPES);
}

// Factory (droid) CLI credential resolution with WorkOS refresh.
//
// The droid CLI stores its WorkOS OAuth tokens encrypted in $FACTORY_HOME
// (default ~/.factory): AES-256-GCM, envelope `iv:tag:ciphertext` (all
// base64), plaintext JSON { access_token, refresh_token,
// active_organization_id, ... }. Two layouts exist and both are supported:
//   droid < 0.231  — envelope auth.v2.file,       key (base64) auth.v2.key
//   droid >= 0.231 — envelope auth.v2.loginkeychain, key in the macOS login
//                    keychain (generic password "Factory CLI", account
//                    "auth-encryption-key-security-cli")
// Access tokens are short-lived JWTs; the CLI refreshes them silently, so we
// do the same and write the rotated credential back to the SAME envelope file
// (atomic rename) — a concurrent droid read never sees a half-written file,
// and droid keeps working afterwards.
//
// FACTORY_API_KEY (a long-lived fk-... key) bypasses all of this; note it is
// Factory's separate metered API billing, NOT the subscription quota.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ENVELOPE_NAMES, authKeyCommands } from "./platform.js";

// WorkOS user_management endpoint + Factory's production SPA client id. The
// refresh grant must NOT include organization_id (WorkOS answers
// organization_not_found when it does).
export const DEFAULT_WORKOS_BASE = "https://api.workos.com/user_management";
export const DEFAULT_WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
// Refresh when the access token has this many ms (or less) of life left.
const EXPIRY_SKEW_MS = 60_000;
// droid keeps the envelope's AES key in the OS keyring once it has one (macOS
// login keychain, Windows Credential Manager, Linux Secret Service) instead of
// a plaintext auth.v2.key file, and names the envelope after that backend —
// same `iv:tag:ciphertext` base64 format either way.

export function factoryHome() {
  return process.env.FACTORY_HOME ?? path.join(os.homedir(), ".factory");
}

/** The envelope droid wrote in `dir`, or undefined when there is none. Every
 *  name droid may have used is checked, so a Windows or Linux install (which
 *  writes `auth.v2.keyring`) is recognised the same as a macOS one. */
export function findEnvelope(dir, { exists = fs.existsSync } = {}) {
  for (const name of ENVELOPE_NAMES) {
    const candidate = path.join(dir, name);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* unreadable directory — treat as absent */
    }
  }
  return undefined;
}

/** The encrypted-envelope file droid currently maintains: the one that exists,
 *  else the name that matches the backend holding the key
 *  (`auth.v2.keyring` for the generic keyring on Windows/Linux,
 *  `auth.v2.loginkeychain` for the macOS login keychain, `auth.v2.file` for the
 *  legacy plaintext-key layout). */
export function envelopeFile(
  home,
  { platform = process.platform, exists = fs.existsSync } = {},
) {
  const found = findEnvelope(home, { exists });
  if (found !== undefined) return found;
  if (platform === "darwin") return path.join(home, "auth.v2.loginkeychain");
  if (platform === "win32" || platform === "linux") return path.join(home, "auth.v2.keyring");
  return path.join(home, "auth.v2.file");
}

/** Decode one stored key value. droid writes base64; a keyring blob can carry
 *  NUL bytes (a UTF-16 string) and a Windows key file can carry CRLF, so both
 *  are stripped before the base64 check. Returns undefined for anything that
 *  cannot be a key, which keeps a wrong lookup from surfacing later as an
 *  unexplained GCM failure. */
export function normalizeKey(raw) {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/\u0000/g, "").replace(/\s+/g, "");
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return undefined;
  const key = Buffer.from(cleaned, "base64");
  return key.length === 0 ? undefined : key;
}

/** One credential read from the Windows Credential Manager is printed as
 *  `user<TAB>secret`; a target can hold several credentials, so a mismatching
 *  user name means this is somebody else's entry. */
function parseWindowsCredential(output, account) {
  const tab = output.indexOf("\t");
  if (tab < 0) return output;
  const user = output.slice(0, tab).trim();
  const secret = output.slice(tab + 1);
  if (account !== undefined && user.length > 0 && user !== account) return undefined;
  return secret;
}

function defaultRunCommand(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

let cachedKey;
let cachedKeyHome;

/**
 * The AES key for a given home, with the source that supplied it. Order:
 *   1. that home's `auth.v2.key` file
 *   2. the default home's `auth.v2.key` — the droid key is per-machine, so an
 *      account snapshot (a secondary home) decrypts with the machine key
 *   3. `FACTORY_AUTH_KEY` (operator override, any platform)
 *   4. `FACTORY_AUTH_KEY_COMMAND` (operator escape hatch: a command whose stdout
 *      is the key — the way to plug in a locked-down machine's own retrieval)
 *   5. the OS keyring: macOS login keychain, Windows Credential Manager,
 *      Linux Secret Service
 * Cached per home for the process; a failed decrypt clears the cache so a
 * re-login is picked up without a restart.
 */
export function resolveAuthKey(home = factoryHome(), options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    defaultHome = factoryHome(),
    readFile = (file, encoding) => fs.readFileSync(file, encoding),
    runCommand = defaultRunCommand,
  } = options;
  const attempts = [];
  const readKeyFile = (file, source) => {
    try {
      const key = normalizeKey(readFile(file, "utf8"));
      if (key !== undefined) {
        attempts.push(`${source}:ok`);
        return key;
      }
      attempts.push(`${source}:unusable`);
    } catch {
      attempts.push(`${source}:absent`);
    }
    return undefined;
  };

  const local = readKeyFile(path.join(home, "auth.v2.key"), "auth.v2.key");
  if (local !== undefined) return { key: local, source: "auth.v2.key", attempts };
  if (home !== defaultHome) {
    const machine = readKeyFile(path.join(defaultHome, "auth.v2.key"), "default-auth.v2.key");
    if (machine !== undefined) return { key: machine, source: "default-auth.v2.key", attempts };
  }
  if (typeof env.FACTORY_AUTH_KEY === "string") {
    const key = normalizeKey(env.FACTORY_AUTH_KEY);
    attempts.push(key === undefined ? "FACTORY_AUTH_KEY:unusable" : "FACTORY_AUTH_KEY:ok");
    if (key !== undefined) return { key, source: "FACTORY_AUTH_KEY", attempts };
  }
  if (typeof env.FACTORY_AUTH_KEY_COMMAND === "string" && env.FACTORY_AUTH_KEY_COMMAND.length > 0) {
    try {
      const key = normalizeKey(runCommand(env.FACTORY_AUTH_KEY_COMMAND, []));
      attempts.push(key === undefined ? "FACTORY_AUTH_KEY_COMMAND:unusable" : "FACTORY_AUTH_KEY_COMMAND:ok");
      if (key !== undefined) return { key, source: "FACTORY_AUTH_KEY_COMMAND", attempts };
    } catch {
      attempts.push("FACTORY_AUTH_KEY_COMMAND:failed");
    }
  }
  for (const command of authKeyCommands({ platform, env })) {
    try {
      const raw = runCommand(command.file, command.args);
      const secret =
        command.parse === "windows-credential"
          ? parseWindowsCredential(raw, command.account)
          : raw;
      const key = normalizeKey(secret ?? "");
      attempts.push(key === undefined ? `${command.id}:unusable` : `${command.id}:ok`);
      if (key !== undefined) return { key, source: command.id, attempts };
    } catch {
      attempts.push(`${command.id}:absent`);
    }
  }
  return { key: undefined, source: undefined, attempts };
}

/** The machine's envelope key, or undefined when no source has it. */
export function readAuthKey(home = factoryHome(), options = {}) {
  const bypassCache = Object.keys(options).length > 0;
  if (!bypassCache && cachedKey !== undefined && cachedKeyHome === home) return cachedKey;
  const { key, source } = resolveAuthKey(home, options);
  if (key !== undefined) {
    cachedKey = key;
    cachedKeyHome = home;
    keySource = source;
  }
  return key;
}

let keySource;

/** Which source supplied the cached key — surfaced by the status route so a
 *  machine that cannot read its key says so instead of looking logged out. */
export function authKeySource() {
  return keySource;
}

function forgetAuthKey() {
  cachedKey = undefined;
  cachedKeyHome = undefined;
  keySource = undefined;
}

/** Decrypt the full credential envelope (not just the access token) so the
 * refresh token survives and can be re-encrypted after rotation. */
export function decryptCredential(home = factoryHome(), options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const key = readAuthKey(home, options);
      if (key === undefined) return undefined;
      const [iv, tag, ct] = fs
        .readFileSync(envelopeFile(home, options), "utf8")
        .trim()
        .split(":")
        .map((s) => Buffer.from(s, "base64"));
      if (!iv || !tag || !ct) return undefined;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const parsed = JSON.parse(
        Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"),
      );
      if (typeof parsed?.access_token !== "string") return undefined;
      return parsed;
    } catch {
      // A stale cached key (re-login rotated it) fails the GCM tag check;
      // forget it and read the current one from the keychain once.
      if (attempt === 0 && cachedKey !== undefined) {
        forgetAuthKey();
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Re-encrypt in the droid CLI's exact envelope: `iv:tag:ciphertext`, all
 * base64, AES-256-GCM with a fresh 12-byte IV. Atomic write, back to the
 * same file droid reads. */
export function writeCredential(creds, home = factoryHome(), options = {}) {
  const key = readAuthKey(home, options);
  if (key === undefined) throw new Error("no Factory encryption key available");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(creds), "utf8"),
    cipher.final(),
  ]);
  const envelope = [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
  const file = envelopeFile(home);
  const tmp = `${file}.dsh-factory-tmp`;
  fs.writeFileSync(tmp, envelope, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Best-effort JWT exp (ms). Undefined for non-JWT (fk-...) keys. */
export function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString("utf8"),
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function isExpired(token, now) {
  const exp = tokenExpiryMs(token);
  if (exp === undefined) return false; // opaque key: caller-managed
  return now() >= exp - EXPIRY_SKEW_MS;
}

/** Exchange the refresh token for a new access/refresh pair and persist it.
 * Returns the rotated credential, or undefined on failure. `home` selects the
 * credential directory for the write-back (the same one the read came from). */
export async function refreshCredential(
  creds,
  { fetchImpl = fetch, now = Date.now, home, ...keyOptions } = {},
) {
  if (typeof creds?.refresh_token !== "string" || creds.refresh_token.length === 0) {
    return undefined;
  }
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: DEFAULT_WORKOS_CLIENT_ID,
    });
    const res = await fetchImpl(
      `${process.env.FACTORY_WORKOS_BASE_URL ?? DEFAULT_WORKOS_BASE}/authenticate`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (!res?.ok) return undefined;
    const data = await res.json();
    if (typeof data?.access_token !== "string") return undefined;
    // WorkOS rotates refresh tokens; keep the new one, fall back to the old.
    // Unknown fields (e.g. droid's `whoami`) are preserved verbatim.
    const next = {
      ...creds,
      access_token: data.access_token,
      refresh_token:
        typeof data.refresh_token === "string" ? data.refresh_token : creds.refresh_token,
      active_organization_id:
        data.active_organization_id ?? creds.active_organization_id ?? null,
    };
    try {
      writeCredential(next, home, keyOptions);
    } catch {
      /* best-effort: a failed write just means we refresh again next time */
    }
    return next;
  } catch {
    return undefined;
  }
}

/** Resolve the credential stored in a specific FACTORY_HOME-style directory,
 * refreshing (and writing the rotation back into that same home) when the
 * access token is expired or `force`d. Shared by the token resolver and the
 * per-account quota reader. */
export async function resolveCredentialForHome(
  home,
  { force = false, fetchImpl = fetch, now = Date.now, ...keyOptions } = {},
) {
  let creds = decryptCredential(home, keyOptions);
  if (creds === undefined) return undefined;
  if (force || isExpired(creds.access_token, now)) {
    const rotated = await refreshCredential(creds, { fetchImpl, now, home, ...keyOptions });
    if (rotated === undefined) {
      // Refresh failed: fall through with what we have only when not forced.
      if (force) return undefined;
    } else {
      creds = rotated;
    }
  }
  return creds;
}

/**
 * Single-flight token resolver. Order per resolve():
 *   1. FACTORY_API_KEY (env or the harness credential store) — long-lived, bypass
 *   2. the droid CLI envelope — `activeHome()` picks which FACTORY_HOME-style
 *      directory to use (undefined = the default droid CLI login), refreshed
 *      proactively inside `refreshWindowMs` and again on demand (the gateway
 *      calls `forceRefresh` after an upstream 401)
 * `state()` reports what the last resolution decided, for the status route.
 */
export function createTokenResolver({
  keyEnv = "FACTORY_API_KEY",
  resolveKey,
  activeHome,
  disabled,
  fetchImpl = fetch,
  now = Date.now,
  refreshWindowMs = 15 * 60_000,
} = {}) {
  let inFlight = undefined;
  let last = undefined; // { token, source, expiresAt, orgId, refreshedAt }
  let generation = 0;

  async function resolveOnce({ force, gen }) {
    // 1. long-lived API key (separate metered billing — still the cleanest remote path)
    if (resolveKey) {
      try {
        const key = await resolveKey(keyEnv);
        if (typeof key === "string" && key.length > 0) {
          last = { token: key, source: "api-key", expiresAt: undefined, orgId: undefined };
          return last;
        }
      } catch {
        /* fall through to the CLI envelope */
      }
    }
    if (process.env[keyEnv]) {
      const key = process.env[keyEnv];
      last = { token: key, source: "api-key", expiresAt: undefined, orgId: undefined };
      return last;
    }
    // 2. an explicitly disabled plugin serves nothing at all: no snapshot and
    //    no droid CLI login. This is what deleting the account in use does, so
    //    that a deleted account really does stop quota reads and model calls.
    if (disabled?.() === true) {
      last = { token: undefined, source: "disabled", expiresAt: undefined, orgId: undefined };
      return last;
    }
    // 3. droid CLI envelope (default login or the active account snapshot)
    const creds = await resolveCredentialForHome(activeHome?.(), { force, fetchImpl, now });
    if (gen !== generation) return { token: undefined, source: "switched", expiresAt: undefined, orgId: undefined };
    if (creds === undefined) {
      last = { token: undefined, source: "none", expiresAt: undefined, orgId: undefined };
      return last;
    }
    last = {
      token: creds.access_token,
      source: "droid-cli",
      expiresAt: tokenExpiryMs(creds.access_token),
      orgId:
        typeof creds.active_organization_id === "string"
          ? creds.active_organization_id
          : undefined,
    };
    return last;
  }

  return {
    /** Resolve a usable token. Concurrent callers share one refresh. */
    async resolve({ force = false } = {}) {
      if (!force && last?.token !== undefined) return last;
      if (inFlight !== undefined) return inFlight;
      const gen = generation;
      inFlight = resolveOnce({ force, gen })
        .catch(() => ({ token: undefined, source: "error", expiresAt: undefined, orgId: undefined }))
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    /** Drop the cached token and re-resolve (used after an upstream 401). */
    async forceRefresh() {
      last = undefined;
      return this.resolve({ force: true });
    },
    /** Drop every cached token because the active account changed. A resolve
     * already in flight is discarded via the generation counter. */
    reset() {
      generation += 1;
      last = undefined;
      inFlight = undefined;
    },
    /** Refresh proactively when the token dies inside the window. */
    async tick() {
      if (last?.source === "api-key") return;
      const exp = last?.expiresAt;
      if (exp === undefined || now() >= exp - refreshWindowMs) {
        last = undefined;
        await this.resolve();
      }
    },
    state() {
      return last === undefined
        ? { source: "unknown" }
        : {
            source: last.source,
            expiresAt: last.expiresAt,
            orgId: last.orgId,
          };
    },
  };
}

// Account vault: several Factory logins side by side, switchable from the
// settings page. Modeled on factory-switcher's isolated-home pattern:
//
//   <root>/<id>/auth.v2.keyring          — the droid CLI's own encrypted
//                                         envelope (AES-256-GCM, machine key
//                                         from the OS keyring / auth.v2.key),
//                                         NOT a new key material we invented.
//                                         droid names the envelope after the
//                                         backend that holds the key, so
//                                         auth.v2.loginkeychain (macOS) and
//                                         auth.v2.file (legacy) are read too.
//   <root>/<id>/meta.json               — label / identity metadata (no tokens)
//   <root>/active.json                  — which account the gateway uses;
//                                         absent = the default droid CLI login
//
// A new account is added by the official login flow in an isolated home:
// `FACTORY_HOME_OVERRIDE=<root>/<id> droid` performs the browser OAuth and
// writes its envelope there; the vault adopts it once it appears. Switching
// only changes which envelope the plugin's token resolver reads — the droid
// CLI's own login (~/.factory) is never touched.
//
// The droid CLI honors FACTORY_HOME_OVERRIDE (verified against the 0.231.0
// binary); the plugin's own reader uses FACTORY_HOME for the same purpose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptCredential,
  findEnvelope,
  resolveCredentialForHome,
  tokenExpiryMs,
  writeCredential,
} from "./credentials.js";
import { findDroidExecutable, loginCommand } from "./platform.js";

export const META_FILE = "meta.json";
const ACTIVE_FILE = "active.json";

export function accountsRoot() {
  return (
    process.env.DSH_FACTORY_ACCOUNTS_DIR ??
    path.join(os.homedir(), ".dsh-factory-provider", "accounts")
  );
}

function ensureRoot() {
  const root = accountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function accountDir(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`invalid account id: ${JSON.stringify(id)}`);
  }
  return path.join(accountsRoot(), id);
}

function readMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8"));
    return typeof meta === "object" && meta !== null ? meta : undefined;
  } catch {
    return undefined;
  }
}

function writeMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });
}

/**
 * The directory that actually holds the account's envelope. `FACTORY_HOME_OVERRIDE`
 * makes droid treat the override as the home BASE, so an isolated-home login
 * lands in `<dir>/.factory/` — one level below the snapshot root. Accept both.
 */
function envelopeDir(dir) {
  if (findEnvelope(dir) !== undefined) return dir;
  const nested = path.join(dir, ".factory");
  if (findEnvelope(nested) !== undefined) return nested;
  return undefined;
}

function hasEnvelope(dir) {
  return envelopeDir(dir) !== undefined;
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Stable identity claims of a credential: WorkOS user id + active org, plus
 * display fields from the access-token JWT. */
function identityOf(creds) {
  const payload = jwtPayload(creds?.access_token ?? "");
  const userId = typeof payload?.sub === "string" ? payload.sub : undefined;
  const orgId =
    typeof creds?.active_organization_id === "string"
      ? creds.active_organization_id
      : typeof payload?.org_id === "string"
        ? payload.org_id
        : undefined;
  const email = typeof payload?.email === "string" ? payload.email : undefined;
  const name =
    [payload?.first_name, payload?.last_name].filter(Boolean).join(" ") || undefined;
  return { userId, orgId, email, name };
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "account"
  );
}

/**
 * Every saved account, resolved against the current machine key. Accounts
 * whose envelope cannot be decrypted (e.g. created on another machine) are
 * reported as `unreadable` instead of hidden. `defaultIdentity` marks the
 * snapshot that matches the live droid CLI login, if any.
 */
export function listAccounts() {
  const root = accountsRoot();
  let entries = [];
  try {
    entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const defaultIdentity = identityOf(decryptCredential());
  const accounts = [];
  for (const id of entries.sort()) {
    const dir = path.join(root, id);
    const meta = readMeta(dir) ?? {};
    const home = envelopeDir(dir);
    if (home === undefined) {
      accounts.push({ id, state: "pending", label: meta.label ?? id });
      continue;
    }
    const creds = decryptCredential(home);
    if (creds === undefined) {
      accounts.push({ id, state: "unreadable", label: meta.label ?? id });
      continue;
    }
    const identity = identityOf(creds);
    const record = {
      id,
      state: "ready",
      label: meta.label ?? identity.email ?? identity.name ?? id,
      email: identity.email,
      userId: identity.userId,
      orgId: identity.orgId,
      premBaseHost:
        typeof creds.whoami?.premBaseHostV2 === "string"
          ? creds.whoami.premBaseHostV2
          : (meta.premBaseHost ?? undefined),
      expiresAt: tokenExpiryMs(creds.access_token),
      addedAt: meta.addedAt ?? null,
      matchesDroidCli:
        defaultIdentity?.userId !== undefined &&
        defaultIdentity.userId === identity.userId &&
        (defaultIdentity.orgId ?? "") === (identity.orgId ?? ""),
    };
    if (meta.pending) {
      // First sighting after the isolated-home login: adopt it.
      writeMeta(dir, {
        label: record.label,
        addedAt: new Date().toISOString(),
        userId: identity.userId,
        orgId: identity.orgId,
        premBaseHost: record.premBaseHost ?? null,
        pending: false,
      });
    }
    accounts.push(record);
  }
  return accounts;
}

/** Upsert a snapshot of `creds` (an envelope payload, not a bare token).
 * Identity (WorkOS user id + org) dedupes re-saves of the same login. */
export function saveAccount({ label, creds } = {}) {
  if (typeof creds?.access_token !== "string" || creds.access_token.length === 0) {
    throw new Error("no credential to save");
  }
  const identity = identityOf(creds);
  if (identity.userId === undefined) {
    throw new Error("cannot determine the account identity from this credential");
  }
  const root = ensureRoot();
  const existing = listAccounts().find(
    (a) =>
      a.state === "ready" &&
      a.userId === identity.userId &&
      (a.orgId ?? "") === (identity.orgId ?? ""),
  );
  const id = existing?.id ?? `${slug(label || identity.email || identity.userId)}-${Date.now().toString(36)}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeCredential(creds, dir);
  writeMeta(dir, {
    label: label ?? existing?.label ?? identity.email ?? id,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    userId: identity.userId,
    orgId: identity.orgId,
    premBaseHost:
      typeof creds.whoami?.premBaseHostV2 === "string" ? creds.whoami.premBaseHostV2 : null,
    pending: false,
  });
  return { id, created: existing === undefined };
}

/** Snapshot the live droid CLI login (the default home's envelope). */
export function saveCurrentAccount({ label } = {}) {
  const creds = decryptCredential();
  if (creds === undefined) {
    throw new Error("no droid CLI login to save — run `droid` once first");
  }
  return saveAccount({ label, creds });
}

/** Create a directory for the isolated-home official login and return the
 * exact command to run. The vault adopts the account once droid writes its
 * envelope there. */
export function createPendingAccount({ label } = {}) {
  const root = ensureRoot();
  const id = `${slug(label || "login")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeMeta(dir, { label: label || id, pending: true });
  // The login runs the real CLI in an isolated home, so the command has to be
  // pasteable on this OS: `VAR=value cmd` is not valid in cmd.exe or PowerShell,
  // and droid is often installed outside PATH (npm prefix, the desktop app).
  const droid = findDroidExecutable() ?? "droid";
  return {
    id,
    command: loginCommand({ home: dir, droid }),
    windowsCommand: loginCommand({ home: dir, droid, shell: "cmd" }),
    home: dir,
  };
}

export function deleteAccount(id) {
  const dir = accountDir(id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  // Deleting the account in use stops credential serving outright. Falling
  // back to the droid CLI's login (or to another snapshot) would keep quota
  // and model calls working, which is not what deleting it means.
  if (getActiveAccountId() === id) disableCredentials();
}

function readActiveFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(accountsRoot(), ACTIVE_FILE), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function getActiveAccountId() {
  const parsed = readActiveFile();
  return typeof parsed?.activeId === "string" ? parsed.activeId : undefined;
}

/**
 * How the gateway gets its credential:
 *   "account" — the saved snapshot named by active.json
 *   "default" — the droid CLI's own login (~/.factory); the out-of-box state
 *   "off"     — nothing. Quota reads and model calls fail until an account is
 *               chosen again, which is what "delete" has to mean: silently
 *               falling back to another login is what made deleting the
 *               account in use look like it did nothing.
 */
export function getCredentialMode() {
  const parsed = readActiveFile();
  if (typeof parsed?.activeId === "string") return "account";
  return parsed?.mode === "off" ? "off" : "default";
}

/** Stop serving any credential, until an account is picked or the default
 *  login is restored. */
export function disableCredentials() {
  ensureRoot();
  fs.writeFileSync(path.join(accountsRoot(), ACTIVE_FILE), JSON.stringify({ mode: "off" }), {
    mode: 0o600,
  });
}

/** Go back to the droid CLI's own login. */
export function useDefaultCredentials() {
  fs.rmSync(path.join(accountsRoot(), ACTIVE_FILE), { force: true });
}

/** Point the gateway at an account (`id`) or back at the default droid CLI
 * login (`undefined`). */
export function setActiveAccountId(id) {
  if (id === undefined || id === null) {
    useDefaultCredentials();
    return;
  }
  const dir = accountDir(id);
  if (!hasEnvelope(dir)) throw new Error(`account "${id}" has no login yet`);
  ensureRoot();
  fs.writeFileSync(
    path.join(accountsRoot(), ACTIVE_FILE),
    JSON.stringify({ activeId: id, mode: "account" }),
    { mode: 0o600 },
  );
}

/** The FACTORY_HOME-style directory of the active account, or undefined when
 *  the default droid CLI login should be used. Callers must consult
 *  {@link getCredentialMode} first: `undefined` also covers "off", where no
 *  login may be used at all. */
export function activeAccountHome() {
  const id = getActiveAccountId();
  if (id === undefined) return undefined;
  return envelopeDir(path.join(accountsRoot(), id));
}

/** Resolve (refreshing in place if needed) the credential of one account. */
export async function resolveAccountCredential(id, { force = false, fetchImpl = fetch } = {}) {
  const home = envelopeDir(accountDir(id));
  if (home === undefined) throw new Error(`account "${id}" has no login yet`);
  return resolveCredentialForHome(home, { force, fetchImpl });
}

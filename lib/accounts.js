// Account vault: Factory API keys, one directory per key, switchable from the
// settings page.
//
//   <root>/<id>/api-key     — the `fk-…` string itself, mode 0600
//   <root>/<id>/meta.json   — label / addedAt (never the key)
//   <root>/active.json      — which key the gateway uses; `{mode:"off"}` means
//                             "serve no credential at all"
//
// This plugin talks to Factory with an API key and nothing else. There is no
// droid CLI login, no encrypted envelope, no OS keyring and no OAuth refresh:
// a key is a long-lived credential that authenticates the same subscription
// account, verified against the inference host and the billing endpoint.
//
// Directories left behind by an older build (which snapshotted droid CLI
// logins) are reported as `legacy` so they can be seen and deleted rather than
// silently ignored.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const META_FILE = "meta.json";
const KEY_FILE = "api-key";
const ACTIVE_FILE = "active.json";

export function accountsRoot() {
  return (
    process.env.DSH_FACTORY_ACCOUNTS_DIR ??
    path.join(os.homedir(), ".dsh-factory-provider", "accounts")
  );
}

/** mkdir/writeFile modes only apply when the entry is created, so an existing
 *  directory or file keeps whatever permissions it already had. Tightening is
 *  therefore explicit — and only meaningful on POSIX, where the mode bits are
 *  what protects the key. */
function tighten(target, mode) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not restrict permissions on ${target}: ${message}`);
  }
}

function ensureRoot() {
  const root = accountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  tighten(root, 0o700);
  return root;
}

function accountDir(id) {
  if (!isValidAccountId(id)) {
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
  const file = path.join(dir, META_FILE);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), { mode: 0o600 });
  tighten(file, 0o600);
}

/** Last four characters, the way Factory's own dashboard labels a key. */
export function keyHint(key) {
  return typeof key === "string" && key.length >= 4 ? key.slice(-4) : undefined;
}

function readApiKey(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, KEY_FILE), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Directories from the droid-CLI era, which this build cannot read. */
function isLegacy(dir) {
  try {
    return fs
      .readdirSync(dir)
      .some((name) => name.startsWith("auth.v2.") || name === ".factory");
  } catch {
    return false;
  }
}

/**
 * Every saved key. A directory without a key is either a legacy snapshot (from
 * the droid-CLI build) or an empty leftover; both are listed so the user can
 * clear them, and neither is ever used as a credential.
 */
export function listAccounts() {
  let entries = [];
  try {
    entries = fs
      .readdirSync(accountsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const accounts = [];
  for (const id of entries.sort()) {
    const dir = path.join(accountsRoot(), id);
    const meta = readMeta(dir) ?? {};
    const key = readApiKey(dir);
    if (key !== undefined) {
      accounts.push({
        id,
        kind: "api-key",
        state: "ready",
        label: meta.label ?? `API key …${keyHint(key) ?? ""}`,
        keyHint: keyHint(key),
        addedAt: meta.addedAt ?? null,
      });
      continue;
    }
    if (isLegacy(dir)) {
      accounts.push({ id, kind: "legacy", state: "legacy", label: meta.label ?? id });
      continue;
    }
    accounts.push({ id, kind: "empty", state: "empty", label: meta.label ?? id });
  }
  return accounts;
}

/** Every stored key, so re-saving the same key updates its entry. */
function findKeyAccount(key) {
  let entries = [];
  try {
    entries = fs
      .readdirSync(accountsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const id of entries) {
    if (readApiKey(path.join(accountsRoot(), id)) === key) return { id };
  }
  return undefined;
}

/**
 * Store a Factory API key and make it the one the gateway uses.
 * `mode` in active.json is written by the caller-facing switch below.
 */
export function saveApiKeyAccount({ label, key } = {}) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (trimmed.length < 20 || /\s/.test(trimmed)) {
    throw new Error("that does not look like a Factory API key");
  }
  const root = ensureRoot();
  const existing = findKeyAccount(trimmed);
  // The id must be unique per key: a label plus a millisecond timestamp let two
  // different keys saved with the same label in the same millisecond land in one
  // directory, where the second overwrote the first.
  const id = existing?.id ?? `key-${slug(label || keyHint(trimmed) || "api")}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
  fs.writeFileSync(path.join(dir, KEY_FILE), trimmed, { mode: 0o600 });
  tighten(path.join(dir, KEY_FILE), 0o600);
  const previous = readMeta(dir);
  writeMeta(dir, {
    label: label || previous?.label || `API key …${keyHint(trimmed) ?? ""}`,
    addedAt: previous?.addedAt ?? new Date().toISOString(),
    kind: "api-key",
  });
  return { id, created: existing === undefined };
}

export function deleteAccount(id) {
  const dir = accountDir(id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  // Deleting the key in use stops credential serving outright; falling back to
  // another key would keep quota and model calls working, which is not what
  // deleting it means.
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

/** True when the id is one this vault could have created. Every entry point
 *  validates through here — an id read back from active.json is just as
 *  untrusted as one that arrived over the bridge. */
function isValidAccountId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

export function getActiveAccountId() {
  const parsed = readActiveFile();
  if (!isValidAccountId(parsed?.activeId)) return undefined;
  return parsed.activeId;
}

/**
 * How the gateway gets its credential:
 *   "account" — the saved key named by active.json
 *   "none"    — no key selected; only an ambient FACTORY_API_KEY can serve
 *   "off"     — nothing at all, until the user picks a key again
 */
export function getCredentialMode() {
  const parsed = readActiveFile();
  if (isValidAccountId(parsed?.activeId)) return "account";
  return parsed?.mode === "off" ? "off" : "none";
}

/** Stop serving any credential, until a key is picked again. */
export function disableCredentials() {
  ensureRoot();
  fs.writeFileSync(path.join(accountsRoot(), ACTIVE_FILE), JSON.stringify({ mode: "off" }), {
    mode: 0o600,
  });
}

/** Forget the selection: nothing stored is used (an ambient env key may be). */
export function clearActiveAccount() {
  fs.rmSync(path.join(accountsRoot(), ACTIVE_FILE), { force: true });
}

/** Point the gateway at a saved key, or clear the selection with `undefined`. */
export function setActiveAccountId(id) {
  if (id === undefined || id === null) {
    clearActiveAccount();
    return;
  }
  const dir = accountDir(id);
  if (readApiKey(dir) === undefined) throw new Error(`account "${id}" has no key`);
  ensureRoot();
  fs.writeFileSync(
    path.join(accountsRoot(), ACTIVE_FILE),
    JSON.stringify({ activeId: id, mode: "account" }),
    { mode: 0o600 },
  );
}

/** The key of the selected account, or undefined when none is selected. */
export function activeApiKey() {
  const id = getActiveAccountId();
  if (id === undefined) return undefined;
  return readApiKey(path.join(accountsRoot(), id));
}

/** The key of one account, for the per-account quota button. */
export function accountApiKey(id) {
  const key = readApiKey(accountDir(id));
  if (key === undefined) throw new Error(`account "${id}" has no key`);
  return key;
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "key"
  );
}

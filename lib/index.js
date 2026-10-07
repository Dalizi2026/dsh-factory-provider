// dsh-factory-provider — bring a Factory (Droid) subscription into DSH as
// native LLM providers, with a settings page for status, quota, and config.
//
// Wiring on apply():
//   1. a settings section (`dsh-factory-provider` namespace) holds the editable
//      config; the row config in cordis.patch.yml remains the shipped defaults;
//   2. a loopback gateway on the dsh web port forwards llm-pi-ai traffic to
//      Factory's Anthropic (/api/llm/a) and OpenAI (/api/llm/o) routes,
//      attaching the subscription credential per request;
//   3. provider profiles are written into the llm-pi-ai settings namespace —
//      `factory-a` (anthropic-messages), `factory-g` (openai-completions) and
//      `factory-o` (openai-responses) — so the models appear in the native
//      picker;
//   4. a proactive timer retries a provider write that did not land;
//   5. bridge routes (including /token-stats) serve the Web
//      settings card.
// Disposal unregisters the routes and removes the provider profiles it owns
// (recognized by their gateway baseURL, never by key alone).

import z from "@deepseek-ai/schemastery";
import {
  accountApiKey,
  activeApiKey,
  clearActiveAccount,
  deleteAccount,
  disableCredentials,
  getActiveAccountId,
  getCredentialMode,
  listAccounts,
  saveApiKeyAccount,
  setActiveAccountId,
} from "./accounts.js";
import { createTokenResolver } from "./credentials.js";
import { createGateway } from "./gateway.js";
import { journal } from "./journal.js";
import { createTokenStatsHandler } from "./usage.js";
import { fetchQuota } from "./quota.js";
import { ROUTES, buildProviderEntry } from "./catalog.js";
import { installContextOptimization } from "./context.js";
import { installAdaptiveImages } from "./images.js";
import { modelCompactionPolicy, validateModelCompactionTokens, RETIRED_COMPACTION_CEILINGS } from "./compaction-policy.js";
import { FACTORY_MODEL_LIMITS } from "./model-limits.js";

const PI_AI_NS = "llm-pi-ai";
const NS = "dsh-factory-provider";
const GATEWAY_PREFIX = "/api/dsh-factory-provider";
const ROUTE_NAMES = new Set(["anthropic", "generic", "openai"]);
const OWNED_BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/dsh-factory-provider\//;
const DEFAULT_ROUTES = ["generic", "anthropic", "openai"];

export const name = NS;
export const inject = ["webServer", "settings"];

// Settings-section schema (also the card's field list). The shipped row config
// in cordis.patch.yml seeds the same fields.
// Every field is declared `.volatile()`. DSH's settings service refuses to
// write a namespace with no volatile fields — the write comes back as
// `Plugin entry "dsh-factory-provider" has no volatile fields`, so the
// settings card's Save silently failed (and the tick state was then wiped by
// the next poll). This is the schema-side half of that contract; the read side
// is fieldValue() below, because a volatile field parses into a stable
// reference that must be read with `.get()`.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  routes: z.array(z.string()).default([...DEFAULT_ROUTES]).volatile(),
  cliVersion: z.string().default("0.231.0").volatile(),
  apiBaseURL: z.string().default("https://prem.factory.ai").volatile(),
  quotaHost: z.string().default("https://api.factory.ai").volatile(),
  keyEnv: z.string().default("FACTORY_API_KEY").volatile(),
  // `refreshWindowMinutes` used to time droid access-token refreshes. A key
  // never expires, so the field is gone; leftover values in a stored config are
  // ignored (schemastery drops unknown keys).
  proactiveRefreshMinutes: z.number().step(1).min(0).default(5).volatile(),
  // Anthropic needs explicit cache breakpoints; measured 0% -> 99% on this
  // route once they are placed. "auto" leaves a client that manages its own
  // caching alone, "rewrite" takes over, "passthrough" changes nothing.
  anthropicCacheMode: z.union([z.const("passthrough"), z.const("auto"), z.const("rewrite")]).default("auto").volatile(),
  anthropicCacheTTL: z.union([z.const("5m"), z.const("1h")]).default("5m").volatile(),
  anthropicPreferOfficial: z.boolean().default(false).volatile(),
  factoryContextAlignment: z.boolean().default(true).volatile(),
  factoryRequestRecovery: z.boolean().default(true).volatile(),
  // A draggable quota window on the shell overlay. Off by default: a window
  // appearing unasked is worse than one the user turns on.
  quotaFloat: z.boolean().default(false).volatile(),
  // Optional server-side tool-result clearing. It removes old facts from the
  // model's view and can invalidate cache prefixes. New installs default off;
  // explicitly saved choices remain authoritative.
  anthropicToolClear: z.boolean().default(false).volatile(),
  anthropicToolClearKeep: z.number().step(1).min(0).max(50).default(3).volatile(),
  anthropicToolClearTrigger: z.number().step(1).min(0).max(1000000).default(20000).volatile(),
  anthropicToolClearBatchTokens: z.number().step(1).min(0).max(1000000).default(20000).volatile(),
  factoryAdaptiveImages: z.boolean().default(true).volatile(),
  factoryRequestMaxBytes: z.number().step(1).min(0).max(33554432).default(4194304).volatile(),
  opus55CompactionTokens: z.number().step(1).min(16384).max(872000).default(400000).volatile(),
  sonnet55CompactionTokens: z.number().step(1).min(16384).max(872000).default(400000).volatile(),
  glmFlashCompactionTokens: z.number().step(1).min(16384).max(904504).default(900000).volatile(),
  // Keep the published schema serializable without callbacks that capture
  // module imports. Per-model ceilings are checked by the settings hook and
  // bridge below; the runtime additionally clamps to actual request budgets.
  modelCompactionTokens: z.dict(z.number().step(1).min(16384).max(1007232),
    z.union([...Object.keys(FACTORY_MODEL_LIMITS), ...Object.keys(RETIRED_COMPACTION_CEILINGS)].map(id => z.const(id)))).default({}).volatile(),
  anthropicContextOptimization: z.boolean().default(true).volatile(),
  anthropicCompactionHeadroomTokens: z.number().step(1).min(0).max(65536).default(16384).volatile(),
  // Summary output ceiling, further capped by the native host/model policy.
  // This is a limit, not a target length; concise checkpoint instructions and
  // rejection of truncated output remain in the compaction wrapper.
  anthropicSummaryMaxTokens: z.number().step(1).min(512).max(16384).default(16384).volatile(),
  // Summaries do not need the main model's reasoning, and running them on it
  // was 57.5% of all output tokens in a measured session. glm-5.3-flash is
  // verified to read images on the generic route, so image-bearing checkpoints
  // can use it too. If the generic route is off or the model is unchecked this
  // falls back to DSH's configured summary strategy rather than failing.
  anthropicSummaryModel: z.string().default("factory-g/glm-5.3-flash").volatile(),
  modelAllowlist: z.array(z.string()).default([]).volatile(),
});

/**
 * Attach a settings section across dsh-settings API generations. dsh >= rc.1
 * moved the standalone installSettingsSection into SettingsProvider.
 * installSection; older dsh (rc.6..rc.8) exposes only register(). Feature-
 * detect installSection and fall back to the register-based lifecycle so one
 * build serves both.
 */
function installSettingsCompat(ctx, ns, schema, entry, hooks) {
  ctx.inject(["settings"], (sctx) => {
    const settings = sctx.settings;
    if (typeof settings.installSection === "function") {
      settings.installSection(ctx, ns, schema, entry, hooks);
      return;
    }
    const scope = settings.register(ns, schema, {
      base: entry,
      ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
    });
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      hooks.setSource(() => entry);
      hooks.onChange();
    }, `${ns}: settings scope`);
    hooks.onChange();
    scope.watch(() => hooks.onChange());
  });
}

/** A settings-section field parses into a schemastery volatile reference (read
 *  with `.get()`); the same field taken from the row config in
 *  cordis.patch.yml is a plain value. Accept both shapes. */
function fieldValue(raw, fallback) {
  const value =
    raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
  return value === undefined ? fallback : value;
}

/** The namespace config as plain JSON for the settings card. Volatile fields
 *  are references, and a reference serializes as `{}` — not as its value. */
function plainConfig(source) {
  const read = (name, fallback) => fieldValue(source?.[name], fallback);
  return {
    enabled: read("enabled", true),
    routes: read("routes", [...DEFAULT_ROUTES]),
    cliVersion: read("cliVersion", "0.231.0"),
    apiBaseURL: read("apiBaseURL", "https://prem.factory.ai"),
    quotaHost: read("quotaHost", "https://api.factory.ai"),
    keyEnv: read("keyEnv", "FACTORY_API_KEY"),
    proactiveRefreshMinutes: read("proactiveRefreshMinutes", 5),
    anthropicCacheMode: read("anthropicCacheMode", "auto"),
    anthropicCacheTTL: read("anthropicCacheTTL", "5m"),
    anthropicPreferOfficial: read("anthropicPreferOfficial", false),
    factoryContextAlignment: read("factoryContextAlignment", true),
    factoryRequestRecovery: read("factoryRequestRecovery", true),
    quotaFloat: read("quotaFloat", false),
    factoryAdaptiveImages: read("factoryAdaptiveImages", true),
    anthropicToolClear: read("anthropicToolClear", false),
    anthropicToolClearKeep: read("anthropicToolClearKeep", 3),
    anthropicToolClearTrigger: read("anthropicToolClearTrigger", 20000),
    anthropicToolClearBatchTokens: read("anthropicToolClearBatchTokens", 20000),
    factoryRequestMaxBytes: read("factoryRequestMaxBytes", 4194304),
    opus55CompactionTokens: read("opus55CompactionTokens", 400000),
    sonnet55CompactionTokens: read("sonnet55CompactionTokens", 400000),
    glmFlashCompactionTokens: read("glmFlashCompactionTokens", 900000),
    modelCompactionTokens: read("modelCompactionTokens", {}),
    anthropicContextOptimization: read("anthropicContextOptimization", true),
    anthropicCompactionHeadroomTokens: read("anthropicCompactionHeadroomTokens", 16384),
    anthropicSummaryMaxTokens: read("anthropicSummaryMaxTokens", 16384),
    anthropicSummaryModel: read("anthropicSummaryModel", "factory-g/glm-5.3-flash"),
    modelAllowlist: read("modelAllowlist", []),
  };
}

function resolveRoutes(routes) {
  // An omitted key takes the default; an explicit (even empty) list wins.
  if (!Array.isArray(routes)) return [...DEFAULT_ROUTES];
  return [...new Set(routes.filter((r) => ROUTE_NAMES.has(r)))];
}

/** The routes the plugin actually serves right now. `enabled: false` means the
 *  plugin is off, so it serves none — the model list and the forwarding
 *  handlers have to agree on this, or "off" would still answer requests. */
function effectiveRoutes(source) {
  if (fieldValue(source?.enabled, true) === false) return [];
  return resolveRoutes(fieldValue(source?.routes, undefined));
}

function isConflict(error) {
  return Boolean(error) && (error.code === "SETTINGS_CONFLICT" || /conflict/i.test(error.message ?? ""));
}

/** A settings write issued while the HMR queue was applying a profile change is
 *  rejected with "HMR transactions cannot be nested". That is transient, not a
 *  configuration error: retry it like a revision conflict instead of parking the
 *  card on a failure a later tick silently repairs. */
function isTransientWrite(error) {
  if (isConflict(error) || /cannot be nested/i.test(error?.message ?? "")) return true;
  // At startup the plugin can be applied before the host's services are live,
  // and the settings write then fails with "cannot get required service
  // \"loader\" in inactive context". That is a race, not a broken write, so it
  // belongs in the retry loop rather than being reported as a failure.
  return /inactive context|service .* not (yet )?available|not ready/i.test(error?.message ?? "");
}

/** A service-not-ready race needs longer to clear than an HMR transaction. */
function retryDelayMs(error) {
  return isConflict(error) || /cannot be nested/i.test(error?.message ?? "") ? 250 : 1000;
}

function readProviders(settings) {
  const desc = settings.describe().find((d) => String(d.ns) === PI_AI_NS);
  if (desc === undefined) return undefined;
  // `providers` is a volatile field: describe() can hand back the live reference
  // rather than a plain dict, and a reference serializes as `{}` — which made
  // every reconcile compare against nothing, rewrite all three routes forever
  // (`wrote: 3` on every pass) and hide whether a write had actually landed.
  const providers = fieldValue(desc.value?.providers, undefined);
  return { revision: desc.revision, providers: providers ?? {} };
}

/** Provider key → model count, for the reconcile journal line. */
function modelCounts(providers) {
  return Object.fromEntries(
    Object.entries(providers ?? {}).map(([key, entry]) => [
      key,
      Array.isArray(entry?.models) ? entry.models.length : -1,
    ]),
  );
}

/** Reconcile the owned provider profiles: write/refresh the enabled ones,
 * remove ours that are no longer wanted. Revision-fenced with one retry.
 * Returns a diagnostic record for the status route. */
async function reconcileProviders(settings, desired, log) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readProviders(settings);
    if (current === undefined) {
      log?.warn("dsh-factory-provider: llm-pi-ai settings namespace not found — providers not written");
      return { reconcile: "no-namespace" };
    }
    const ops = [];
    for (const [key, entry] of desired) {
      const existing = current.providers[key];
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        ops.push({ op: "set", path: ["providers", key], value: entry });
      }
    }
    for (const [key, entry] of Object.entries(current.providers)) {
      if (desired.has(key)) continue;
      if (OWNED_BASE_RE.test(String(entry?.baseURL ?? ""))) {
        ops.push({ op: "unset", path: ["providers", key] });
      }
    }
    if (ops.length === 0) return { reconcile: "clean", wrote: 0 };
    // Journal what the plugin saw against what it is about to write. Without
    // this, "the write succeeded but the model list never changed" is
    // indistinguishable from "the write never landed": the counts below settle
    // it in one line (seen = the effective entry, desired = ours).
    const diagnostics = {
      desired: modelCounts(desired),
      seen: modelCounts(
        Object.fromEntries(Object.entries(current.providers).filter(([key]) => desired.has(key))),
      ),
      revision: current.revision ?? null,
    };
    try {
      await settings.mutate(PI_AI_NS, ops, current.revision);
      journal({ route: "plugin", event: "reconcile", result: "applied", wrote: ops.length, ...diagnostics });
      return { reconcile: "applied", wrote: ops.length, keys: [...desired.keys()] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal({ route: "plugin", event: "reconcile", result: "failed", error: message, ...diagnostics });
      log?.warn(`dsh-factory-provider: provider reconcile failed: ${message}`);
      if (!isTransientWrite(error) || attempt === 2) return { reconcile: "failed", error: message };
      // An interleaved HMR transaction is short-lived, and a service that is
      // still starting up is close behind; either way, let it clear first.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error)));
    }
  }
  return { reconcile: "failed", error: "revision conflict persisted" };
}

/** Remove every provider profile this plugin owns (gateway baseURL match). */
async function removeOwnedProviders(settings, log) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readProviders(settings);
    if (current === undefined) return;
    const ops = [];
    for (const route of Object.keys(ROUTES)) {
      const key = ROUTES[route].key;
      const entry = current.providers[key];
      if (entry !== undefined && OWNED_BASE_RE.test(String(entry.baseURL ?? ""))) {
        ops.push({ op: "unset", path: ["providers", key] });
      }
    }
    if (ops.length === 0) return;
    try {
      await settings.mutate(PI_AI_NS, ops, current.revision);
      return;
    } catch (error) {
      if (!isConflict(error) || attempt === 2) {
        log?.warn(`dsh-factory-provider: provider cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }
}

// --- bridge handlers (loopback-only, same guard family as the gateway) ---------

function bridgeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (value?.error?.message !== undefined && value.message === undefined) {
    value.message = value.error.message;
  }
  res.end(JSON.stringify(value));
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** apply() is the one place where a crash costs every route, the provider
 *  profiles and the settings section at once — and the host's own logger output
 *  is not readable from outside the app. Record the failure in the plugin's
 *  journal (readable on /journal) before rethrowing, so "the plugin silently
 *  disappeared" stays diagnosable without permanent tracing. */
export function apply(ctx, config) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    journal({
      route: "plugin",
      event: "apply-error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function applyInner(ctx, config) {
  const log = ctx.logger;
  // The settings section's value overrides the shipped row config once the
  // user edits anything; row config stays the default source until then.
  let readConfig = () => config ?? {};

  // Surfaced on the status route so a failed settings write is visible
  // without host log access.
  const pluginState = { reconcile: "pending" };
  pluginState.contextOptimization = {};
  installContextOptimization(ctx, () => readConfig(), pluginState.contextOptimization, journal);
  pluginState.adaptiveImages = {};
  installAdaptiveImages(ctx, () => readConfig(), pluginState.adaptiveImages, journal);

  const initial = readConfig();
  const resolver = createTokenResolver({
    keyEnv: fieldValue(initial.keyEnv, "FACTORY_API_KEY"),
    // The key selected in the settings page; undefined while none is selected,
    // in which case an ambient FACTORY_API_KEY may serve instead.
    activeKey: () => activeApiKey(),
    // "off" after the key in use was deleted: serve nothing rather than quietly
    // falling back to another key.
    disabled: () => getCredentialMode() === "off",
    resolveKey: async (envName) => {
      const credentials = ctx.get("credentials");
      if (credentials === undefined) return undefined;
      const resolved = await credentials.resolve(envName);
      return resolved?.value;
    },
  });

  const gateway = createGateway({
    resolver,
    enabledRoutes: effectiveRoutes(initial),
    cacheMode: fieldValue(initial.anthropicCacheMode, "auto"),
    cacheTTL: fieldValue(initial.anthropicCacheTTL, "5m"),
    toolClear: fieldValue(initial.anthropicToolClear, false),
    toolClearKeep: fieldValue(initial.anthropicToolClearKeep, 3),
    toolClearTrigger: fieldValue(initial.anthropicToolClearTrigger, 20000),
    toolClearBatchTokens: fieldValue(initial.anthropicToolClearBatchTokens, 20000),
    requestMaxBytes: fieldValue(initial.factoryRequestMaxBytes, 4194304),
    gatewayPrefix: GATEWAY_PREFIX,
    apiBaseURL: fieldValue(initial.apiBaseURL, "https://prem.factory.ai"),
    cliVersion: fieldValue(initial.cliVersion, "0.231.0"),
    routingHost: fieldValue(initial.quotaHost, 'https://api.factory.ai'),
    routingFetch: fetch,
    preferAnthropic: fieldValue(initial.anthropicPreferOfficial, false),
    logger: log,
    pluginState: () => ({
      ...pluginState,
      adaptiveImages: { ...pluginState.adaptiveImages,
        ...(fieldValue(readConfig().factoryAdaptiveImages, true) === false || fieldValue(readConfig().enabled, true) === false ? { state: "disabled" } : {}) },
      contextOptimization: {
        ...pluginState.contextOptimization,
        ...(fieldValue(readConfig().enabled, true) === false ||
          (fieldValue(readConfig().factoryRequestRecovery, true) === false && fieldValue(readConfig().factoryContextAlignment, true) === false &&
           (!effectiveRoutes(readConfig()).includes("anthropic") ||
            fieldValue(readConfig().anthropicContextOptimization, true) === false))
          ? { state: "disabled" } : {}),
      },
    }),
  });

  // The settings section can change before the webServer half is live, and
  // after it is gone. The onChange hook therefore cannot call into that half
  // directly — it asks this handle, which the injected half fills in when it is
  // ready. A change that arrives too early is replayed once it is.
  let runtime;
  let pendingApply = false;
  const requestApply = () => {
    if (runtime === undefined) {
      pendingApply = true;
      return;
    }
    runtime.applyConfig();
  };

  installSettingsCompat(ctx, NS, Config, config ?? {}, {
    validate: next => { validateModelCompactionTokens(fieldValue(next?.modelCompactionTokens, {})); },
    setSource: (src) => {
      readConfig = src;
    },
    onChange: requestApply,
  });

  ctx.inject(["webServer", "settings"], (sctx) => {
    const webServer = sctx.webServer;
    const settings = sctx.settings;
    const port = webServer?.port;
    if (!webServer || port === undefined) {
      log?.warn("dsh-factory-provider: webServer/port unavailable — gateway and providers not registered");
      return () => {};
    }

    // Every registration this half makes goes through here. Registering one at
    // a time keeps partial progress, and collecting the disposers in one list
    // means unload releases everything: the two route groups used to share a
    // single variable, so the second assignment silently dropped the first
    // group's disposers.
    const disposers = [];
    const registerRoute = (route) => {
      try {
        const dispose = webServer.register(route);
        if (typeof dispose === "function") disposers.push(dispose);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log?.warn(`dsh-factory-provider: route ${route.path} registration failed: ${message}`);
        return false;
      }
    };
    // Unload runs this after the routes are gone. A failing settings write must
    // not turn the disposer into a throwing one, and the reason has to be
    // visible rather than swallowed.
    const cleanupProviders = () => {
      try {
        void removeOwnedProviders(settings, log);
      } catch (error) {
        log?.warn(
          `dsh-factory-provider: provider cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const disposeRoutes = () => {
      // Idempotent, and one throwing disposer must not strand the rest.
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (error) {
          log?.warn(`dsh-factory-provider: route dispose failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    // Gateway routes (status stays available even when disabled, for diagnostics).
    for (const route of gateway.routes) registerRoute(route);

    // --- bridge routes for the settings card ---
    // Management routes are loopback-only, exactly like the inference gateway.
    // Without this, an external caller reaching a host that was bound to 0.0.0.0
    // for LAN access could read diagnostics, disable or delete accounts, rewrite
    // the config, or spend quota through /test.
    const guarded = (handler) => (req, res) => {
      if (!gateway.isLoopback(req)) {
        bridgeJson(res, 403, {
          ok: false,
          code: "forbidden",
          error: { message: "dsh-factory-provider: loopback callers only" },
        });
        return;
      }
      return handler(req, res);
    };
    const bridgeRoutes = [
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/token-stats`,
        handler: guarded(createTokenStatsHandler({ reply: bridgeJson })),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/quota`,
        handler: guarded(async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "quota is GET" } });
            return;
          }
          const result = await fetchQuota({ resolver, host: fieldValue(readConfig().quotaHost, "https://api.factory.ai") });
          bridgeJson(res, 200, result);
        }),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/accounts`,
        handler: guarded(async (req, res) => {
          if (req.method === "GET" || req.method === "HEAD") {
            bridgeJson(res, 200, {
              ok: true,
              value: {
                accounts: listAccounts(),
                activeId: getActiveAccountId() ?? null,
                mode: getCredentialMode(),
              },
            });
            return;
          }
          if (req.method !== "POST") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "accounts is GET/POST" } });
            return;
          }
          const body = await readJsonBody(req);
          if (body === null || body === undefined) {
            bridgeJson(res, 400, { ok: false, code: "bad_json", error: { message: "accounts body must be JSON" } });
            return;
          }
          try {
            if (body.action === "save-key") {
              const result = saveApiKeyAccount({ label: body.label, key: body.key });
              journal({ route: "accounts", event: "save-key", shape: { id: result.id, created: result.created } });
              // Selecting it right away is what the user means by pasting a key;
              // switching back is one click in the account list.
              setActiveAccountId(result.id);
              resolver.reset();
              bridgeJson(res, 200, { ok: true, value: result });
              return;
            }
            if (body.action === "switch") {
              setActiveAccountId(body.id);
              resolver.reset();
              journal({ route: "accounts", event: "switch", shape: { id: body.id } });
              bridgeJson(res, 200, { ok: true, value: { activeId: getActiveAccountId() ?? null } });
              return;
            }
            if (body.action === "disable") {
              disableCredentials();
              resolver.reset();
              journal({ route: "accounts", event: "disable" });
              bridgeJson(res, 200, { ok: true, value: { mode: "off" } });
              return;
            }
            if (body.action === "clear") {
              clearActiveAccount();
              resolver.reset();
              journal({ route: "accounts", event: "clear" });
              bridgeJson(res, 200, { ok: true, value: { activeId: null } });
              return;
            }
            if (body.action === "delete") {
              const wasActive = getActiveAccountId() === body.id;
              deleteAccount(body.id);
              if (wasActive) resolver.reset();
              journal({ route: "accounts", event: "delete", shape: { id: body.id } });
              bridgeJson(res, 200, { ok: true });
              return;
            }
            bridgeJson(res, 400, { ok: false, code: "bad_action", error: { message: "unknown accounts action" } });
          } catch (error) {
            bridgeJson(res, 200, {
              ok: false,
              code: "accounts_error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/accounts/quota`,
        handler: guarded(async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "account quota is GET" } });
            return;
          }
          const id = new URL(req.url ?? "/", `http://127.0.0.1`).searchParams.get("id");
          if (typeof id !== "string" || id.length === 0) {
            bridgeJson(res, 400, { ok: false, code: "bad_id", error: { message: "accounts quota needs ?id=" } });
            return;
          }
          try {
            const token = accountApiKey(id);
            const result = await fetchQuota({
              credential: {
                token,
                // A key carries no identity claims, and the billing endpoint
                // answers the right account for the key itself.
                orgId: undefined,
              },
              host: fieldValue(readConfig().quotaHost, "https://api.factory.ai"),
            });
            bridgeJson(res, 200, result);
          } catch (error) {
            bridgeJson(res, 200, {
              ok: false,
              code: "accounts_error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/journal`,
        handler: guarded(async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "journal is GET" } });
            return;
          }
          const { readJournal } = await import("./journal.js");
          bridgeJson(res, 200, { ok: true, value: readJournal(50) });
        }),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/config`,
        handler: guarded(async (req, res) => {
          if (req.method === "GET" || req.method === "HEAD") {
            const desc = settings.describe().find((d) => String(d.ns) === NS);
            bridgeJson(res, 200, {
              ok: true,
              value: {
                config: plainConfig(readConfig()),
                revision: desc?.revision ?? null,
                routes: Object.fromEntries(
                  Object.keys(ROUTES).map((route) => [
                    route,
                    {
                      providerKey: ROUTES[route].key,
                      api: ROUTES[route].api,
                      // Only the models that can actually reach the picker: a
                      // regionGated id is filtered out of the provider entry, so
                      // offering it here would let the user tick something that
                      // can never appear.
                      models: ROUTES[route].models
                        .filter((m) => m.regionGated !== true)
                        .map((m) => ({
                          id: m.id,
                          name: m.name,
                          cost: m.cost,
                          efforts: Object.keys(m.efforts),
                          compaction: modelCompactionPolicy(m.id),
                        })),
                    },
                  ]),
                ),
              },
            });
            return;
          }
          if (req.method !== "POST") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "config is GET/POST" } });
            return;
          }
          // Read the JSON body, then fence the write on the latest revision.
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) {
              bridgeJson(res, 413, { ok: false, code: "too_large", error: { message: "config body too large" } });
              return;
            }
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            bridgeJson(res, 400, { ok: false, code: "bad_json", error: { message: "config body must be JSON" } });
            return;
          }
          const ops = Array.isArray(body?.ops) ? body.ops : [];
          if (ops.length === 0 || !ops.every((op) => op && typeof op.op === "string" && Array.isArray(op.path))) {
            bridgeJson(res, 400, { ok: false, code: "bad_ops", error: { message: "config body needs an ops array" } });
            return;
          }
          try {
            for (const op of ops.filter(op => op.path[0] === "modelCompactionTokens")) {
              if (op.path.length !== 1 || !["set", "add", "remove", "delete"].includes(op.op)) {
                throw new TypeError("Save modelCompactionTokens as a complete dictionary");
              }
              validateModelCompactionTokens(["remove", "delete"].includes(op.op) ? {} : op.value);
            }
          } catch (error) {
            bridgeJson(res, 400, { ok: false, code: "bad_compaction_threshold", message: error.message });
            return;
          }
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const desc = settings.describe().find((d) => String(d.ns) === NS);
            try {
              await settings.mutate(NS, ops, body.expectedRevision ?? desc?.revision);
              bridgeJson(res, 200, { ok: true, value: { revision: settings.describe().find((d) => String(d.ns) === NS)?.revision ?? null } });
              return;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!isConflict(error) || attempt === 2) {
                bridgeJson(res, 200, { ok: false, code: "mutate_failed", message });
                return;
              }
            }
          }
        }),
      },
      {
        kind: "exact",
        path: `${GATEWAY_PREFIX}/test`,
        handler: guarded(async (req, res) => {
          if (req.method !== "POST") {
            bridgeJson(res, 405, { ok: false, code: "method_not_allowed", error: { message: "test is POST" } });
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            /* empty body is fine */
          }
          const route = body?.route === "generic" || body?.route === "openai" ? body.route : "anthropic";
          const result = await gateway.probe(route, body?.model);
          bridgeJson(res, 200, result);
        }),
      },
    ];
    for (const route of bridgeRoutes) registerRoute(route);

    // Provider profiles in llm-pi-ai, kept present while the plugin is live.
    let desired = new Map();    const rebuildDesired = () => {
      const current = readConfig();
      const routes = effectiveRoutes(current);
      const allowlist = fieldValue(current.modelAllowlist, []);
      desired = new Map();
      for (const route of routes) {
        const entry = buildProviderEntry(route, {
          port,
          gatewayPrefix: GATEWAY_PREFIX,
          allowlist,
        });
        if (entry !== undefined && entry.models.length > 0) {
          desired.set(ROUTES[route].key, entry);
        } else {
          log?.warn(`dsh-factory-provider: route "${route}" produced no models — skipped`);
        }
      }
    };
    /** Nudge the plugins that re-derive state from their live config, then the
     *  clients that read it.
     *  1. A settings write updates llm-pi-ai's running config through
     *     `configEditor.edit` → `resolveConfig`, which never emits the loader's
     *     `loader/volatile-update` — and that event is exactly where llm-pi-ai
     *     rebuilds its llm-service registration and model directory. The other
     *     listeners (product-analytics, speech-to-text, llm-deepseek) only
     *     re-read their own unchanged configs.
     *  2. The settings write also makes clients refresh immediately — before that
     *     directory exists — so they cache the previous list. This second, later
     *     announcement is what actually puts the new models in the picker; a
     *     repeat on a short timer covers an asynchronous re-derivation. */
    function announceProviderChange() {
      try {
        ctx.emit("loader/volatile-update", [["providers"]]);
        ctx.emit("llm/adapters-updated");
        const timer = setTimeout(() => {
          try {
            ctx.emit("llm/adapters-updated");
          } catch {
            /* the client simply refetches one event later */
          }
        }, 50);
        timer?.unref?.();
        pluginState.announced = "ok";
      } catch (error) {
        pluginState.announced = "failed";
        pluginState.announceError = error instanceof Error ? error.message : String(error);
        log?.warn(`dsh-factory-provider: model-catalog nudge failed: ${pluginState.announceError}`);
      }
    }

    const runReconcile = () =>
      reconcileProviders(settings, desired, log)
        .then((result) => {
          // Drop results from an earlier attempt: a stale `error` next to a later
          // `applied` is what made the card read "applied — HMR transactions
          // cannot be nested".
          delete pluginState.error;
          delete pluginState.wrote;
          delete pluginState.keys;
          delete pluginState.announced;
          delete pluginState.announceError;
          Object.assign(pluginState, result);
          log?.info(
            `dsh-factory-provider: provider reconcile ${result.reconcile} (${[...desired.keys()].join(", ") || "none"} on port ${port})`,
          );
          // Only a write that changed something needs the catalog rebuilt.
          if (result.reconcile === "applied") announceProviderChange();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          pluginState.reconcile = "failed";
          pluginState.error = message;
          log?.warn(`dsh-factory-provider: provider reconcile threw: ${message}`);
        });

    /** Re-apply the current settings-section config without a restart. */
    function applyConfig() {
      const current = readConfig();
      gateway.configure({
        routes: effectiveRoutes(current),
        apiBaseURL: fieldValue(current.apiBaseURL, "https://prem.factory.ai"),
        cliVersion: fieldValue(current.cliVersion, "0.231.0"),
        routingHost: fieldValue(current.quotaHost, 'https://api.factory.ai'),
        preferAnthropic: fieldValue(current.anthropicPreferOfficial, false),
        cacheMode: fieldValue(current.anthropicCacheMode, "auto"),
        cacheTTL: fieldValue(current.anthropicCacheTTL, "5m"),
        toolClear: fieldValue(current.anthropicToolClear, false),
        toolClearKeep: fieldValue(current.anthropicToolClearKeep, 3),
        toolClearTrigger: fieldValue(current.anthropicToolClearTrigger, 20000),
        toolClearBatchTokens: fieldValue(current.anthropicToolClearBatchTokens, 20000),
        requestMaxBytes: fieldValue(current.factoryRequestMaxBytes, 4194304),
      });
      rebuildDesired();
      void runReconcile();
    }

    rebuildDesired();
    void runReconcile();

    // The injected half is live now, so a settings change that arrived while it
    // was still starting up can be applied — and later ones go straight through.
    runtime = { applyConfig };
    if (pendingApply) {
      pendingApply = false;
      applyConfig();
    }

    // Self-healing: another writer (or a settings reload) dropping our rows
    // re-triggers a reconcile; the refresh tick retries an unsettled attempt.
    if (typeof sctx.on === "function") {
      sctx.effect(
        () =>
          sctx.on("settings/document-updated", (ns) => {
            if (String(ns) !== PI_AI_NS) return;
            void runReconcile();
          }),
        "dsh-factory-provider: settings watch",
      );
    }

    // Periodic maintenance. An API key never expires, so there is no credential
    // refresh left to do here — the timer keeps retrying a provider write that
    // did not land (a transient settings-write failure, a host that was busy).
    let timer;
    let stopped = false;
    const minutes = Math.max(0, fieldValue(readConfig().proactiveRefreshMinutes, 5));
    const tick = () => {
      if (stopped) return;
      if (pluginState.reconcile !== "clean" && pluginState.reconcile !== "applied") {
        void runReconcile();
      }
    };
    if (minutes > 0) {
      const first = setTimeout(() => {
        if (stopped) return;
        tick();
        timer = setInterval(tick, minutes * 60_000);
      }, 10_000);
      return () => {
        stopped = true;
        runtime = undefined;
        clearTimeout(first);
        if (timer) clearInterval(timer);
        disposeRoutes();
        cleanupProviders();
      };
    }
    return () => {
      stopped = true;
      runtime = undefined;
      disposeRoutes();
      cleanupProviders();
    };
  });
}

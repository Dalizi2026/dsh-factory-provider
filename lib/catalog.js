// Factory subscription model catalog, split by the two routes Factory serves.
//
// Both routes live on the inference host droid's whoami hands out
// (`premBaseHostV2`, default https://prem.factory.ai):
//   Route a (Anthropic Messages API): /api/llm/a/v1/messages
//     Claude models, `x-api-provider: bedrock_anthropic`, top-level `system`
//     passed through as block arrays, `thinking` for reasoning control.
//     Verified live against the official CLI's replayed requests.
//   Route o (OpenAI chat/completions): /api/llm/o/v1/chat/completions
//     The Droid Core open-weight pool. Every request needs:
//       - `x-api-provider: fireworks` (per-model upstream backend),
//       - a system message starting with droid's canonical identity line
//         (edge gate — a missing/foreign one is answered 403),
//       - `user-agent: factory-cli/<recent version>`.
//     Verified live against the official CLI's replayed requests.
//   Route o/responses (OpenAI Responses API): /api/llm/o/v1/responses
//     The GPT family (`x-api-provider: azure_openai`). Same edge gate, but the
//     system prompt is read from the top-level `instructions` field here —
//     developer/system messages inside `input` do NOT satisfy it (probed live:
//     instructions missing → 403, present → 200). Also requires the static
//     `openai-platform: org-…` header droid carries (a build-time constant in
//     the CLI binary, not per-account state).
//
// `reasoningEfforts` maps the selector levels the DSH UI offers to the wire
// values the route accepts; the per-model sets come from Factory's official
// model table (docs.factory.com/models) — e.g. GLM-5.3-Flash takes
// low/high/max, Claude Opus 5.5 takes low/medium/high/xhigh/max. Model
// availability was probed live against the account (200 = callable);
// deprecated or region-blocked ids are left out on purpose. glm-5.3-flash is
// first: it is the Droid Core default at 0.06x — low multiplier, but it still
// bills the standard pool before the free Core pool takes over.

const ANTHROPIC_CTX = 200_000;
const ANTHROPIC_OUT = 64_000;
const GENERIC_CTX = 1_040_000;
const GENERIC_OUT = 131_072;
const CORE_CTX = 256_000;
// droid's own compaction math assumes a 200K context and 32K output for the
// GPT family (its config derives maxInputTokens from a 200000 base).
const OPENAI_CTX = 200_000;
const OPENAI_OUT = 32_000;

// Reasoning level sets per Factory's official model table.
// The bedrock_anthropic route refuses `thinking.type.disabled` (its lowest
// setting is an internal `between_tools`), so `off` is never offered on the
// Claude route — the lowest selectable level is `low`.
// Keys are DSH's THINKING_LEVELS; values are the wire spellings. The GPT
// family's docs level `none` is not a DSH selector key, so it is declared as
// `off: "none"` — selecting "off" dispatches reasoning:{effort:"none"}, which
// the azure_openai route accepts (probed live).
const E_NO_OFF = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const E_LOW_MED_HIGH = { low: "low", medium: "medium", high: "high" };
// Claude 4.6 accepts low/medium/high/max but refuses xhigh (probed live).
const E_LOW_MED_HIGH_MAX = { low: "low", medium: "medium", high: "high", max: "max" };
const E_OFF_LOW_HIGH_MAX = { off: "off", low: "low", high: "high", max: "max" };
const E_LOW_HIGH_MAX = { low: "low", high: "high", max: "max" };
const E_HIGH_ONLY = { high: "high" };
const E_OFF_NONE_LOW_HIGH_XHIGH_MAX = { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const E_LOW_MED_HIGH_XHIGH = { low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
const E_OFF_NONE_LOW_MED_HIGH_XHIGH = { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

// Route a — Claude family. `cost` is the official multiplier of the base
// credit unit; Claude draws the subscription's standard rolling quota. Every
// current model on Factory's bedrock_anthropic route uses the ADAPTIVE
// thinking API (`thinking:{type:"adaptive"}` + `output_config.effort`) — the
// older budget form is refused with a 400 ("not supported for this model"),
// and the docs' named-level vocabulary (low/medium/high/xhigh/max) confirms
// it — so each entry sets pi-ai's `forceAdaptiveThinking` compat.
// Every id below was probed live (2026-10-03, this account): 200 = callable.
// `regionGated: true` marks ids whose protocol support is kept wired (the
// gateway still knows the Fast Mode beta) but which this account cannot call —
// the edge answers 400 "Provider not available in this region" — so
// buildModelEntries leaves them out of the picker. Drop the flag when Factory
// opens the region.
// `cost` is omitted where Factory publishes no multiplier for this account.
export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", cost: "1.6x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-opus-5-5-fast", name: "Claude Opus 5.5 Fast", cost: "3.2x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT, anthropicFastMode: true, regionGated: true },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", cost: "2x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-opus-4-8-fast", name: "Claude Opus 4.8 Fast", cost: "4x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT, anthropicFastMode: true, regionGated: true },
  { id: "claude-opus-5", name: "Claude Opus 5", cost: "2x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-opus-5-fast", name: "Claude Opus 5 Fast", cost: "4x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT, anthropicFastMode: true, regionGated: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", cost: "0.8x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", cost: "0.8x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", efforts: E_LOW_MED_HIGH_MAX, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  // The wire id uses a DOT. "claude-fable-5-1" is answered "Invalid model ID"
  // (probed live) even though the response echoes that hyphenated name back.
  { id: "claude-fable-5.1", name: "Fable 5.1", cost: "4x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-fable-5", name: "Fable 5", cost: "4x", efforts: E_NO_OFF, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", cost: "0.4x", efforts: E_LOW_MED_HIGH, adaptive: true, contextWindow: ANTHROPIC_CTX, maxTokens: ANTHROPIC_OUT },
];

// Route o — Droid Core pool, every entry probed callable on fireworks
// (2026-10-03). inkling/qwen3.8-max/nemotron-3-ultra are the current Core
// lineup and take none/low/medium/high/xhigh/max — "off" is not a wire value
// for inkling, which is why the selector's off key maps to `none`.
export const GENERIC_MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash (Droid Core)", cost: "0.06x", efforts: E_LOW_HIGH_MAX, contextWindow: GENERIC_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "inkling", name: "Inkling (Droid Core)", cost: "0.4x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "qwen3.8-max", name: "Qwen3.8 Max (Droid Core)", cost: "0.8x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra (Droid Core)", cost: "0.24x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "glm-5.3", name: "GLM-5.3 (Droid Core)", cost: "0.56x", efforts: E_LOW_HIGH_MAX, contextWindow: GENERIC_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "kimi-k3", name: "Kimi K3 (Droid Core)", cost: "1.2x", efforts: E_OFF_LOW_HIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "minimax-m3", name: "MiniMax M3 (Droid Core)", cost: "0.12x", efforts: E_HIGH_ONLY, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "minimax-m2.7", name: "MiniMax M2.7 (Droid Core)", cost: "0.12x", efforts: E_HIGH_ONLY, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (Factory)", cost: "0.528x", efforts: E_OFF_LOW_HIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731 (Factory)", cost: "0.176x", efforts: E_OFF_LOW_HIGH_MAX, contextWindow: CORE_CTX, maxTokens: GENERIC_OUT, apiProvider: "fireworks" },
];

// Route o/responses — GPT family on azure_openai. Ids/multipliers/effort sets
// from Factory's official model table (docs.factory.com/models); the cheap tier
// (gpt-6-luna 0.04x, gpt-5.6-luna 0.08x, gpt-5.4-mini 0.3x) was probed live
// 200, the premium tier is table-listed but not live-probed for cost reasons.
// `-flex` variants and the image/transcribe models are not part of the coding
// surface and are left out.
export const OPENAI_MODELS = [
  // gpt-6.1-sol is NOT listed: probed live 2026-10-02, the edge answers
  // "Provider not available in this region" for this account. Add it back if
  // Factory opens it up.
  // Same region gate (probed 2026-10-03): gpt-5.5-pro, gpt-5.3-codex-fast.
  { id: "gpt-6-astra", name: "GPT-6 Astra", cost: "4x", efforts: E_NO_OFF, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", cost: "0.8x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", cost: "0.04x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", cost: "1.6x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.6-sol-fast", name: "GPT-5.6 Sol Fast", cost: "3.2x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", cost: "0.8x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", cost: "0.08x", efforts: E_OFF_NONE_LOW_HIGH_XHIGH_MAX, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.5", name: "GPT-5.5", cost: "2x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.5-fast", name: "GPT-5.5 Fast", cost: "5x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.4", name: "GPT-5.4", cost: "1x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.4-fast", name: "GPT-5.4 Fast", cost: "2x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", cost: "0.3x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.4-mini-fast", name: "GPT-5.4 Mini Fast", cost: "0.6x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", cost: "0.7x", efforts: E_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
  { id: "gpt-5.2", name: "GPT-5.2", cost: "0.7x", efforts: E_OFF_NONE_LOW_MED_HIGH_XHIGH, contextWindow: OPENAI_CTX, maxTokens: OPENAI_OUT, apiProvider: "azure_openai" },
];

export const ROUTES = {
  anthropic: {
    key: "factory-a",
    api: "anthropic-messages",
    displayName: "Factory (Droid) — Claude",
    models: ANTHROPIC_MODELS,
    defaultContextWindow: ANTHROPIC_CTX,
    defaultMaxTokens: ANTHROPIC_OUT,
  },
  generic: {
    key: "factory-g",
    api: "openai-completions",
    displayName: "Factory (Droid) — Droid Core",
    models: GENERIC_MODELS,
    defaultContextWindow: GENERIC_CTX,
    defaultMaxTokens: GENERIC_OUT,
  },
  openai: {
    key: "factory-o",
    api: "openai-responses",
    displayName: "Factory (Droid) — GPT",
    models: OPENAI_MODELS,
    defaultContextWindow: OPENAI_CTX,
    defaultMaxTokens: OPENAI_OUT,
  },
};

/** The models a route can actually serve. Region-gated ids are listed by the
 *  edge but answer 400 "Provider not available in this region" here, so every
 *  surface that lists or counts models — provider entries, the /models endpoint
 *  and /status — goes through this. */
export function servableModels(route) {
  const spec = ROUTES[route];
  if (spec === undefined) return [];
  return spec.models.filter((m) => m.regionGated !== true);
}

/** Model entries for the llm-pi-ai provider profile: id/name/limits plus the
 * reasoning-effort selector map (wire values verbatim from the model table). */
export function buildModelEntries(route, allowlist = []) {
  const spec = ROUTES[route];
  if (spec === undefined) return [];
  const allow = new Set(allowlist);
  return servableModels(route)
    .filter((m) => allow.size === 0 || allow.has(m.id))
    .map((m) => ({
      id: m.id,
      name: `${m.name}${m.cost ? ` · ${m.cost}` : ""}`,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: ["text", "image"],
      reasoningEfforts: m.efforts,
      ...(m.adaptive === true ? { compat: { forceAdaptiveThinking: true } } : {}),
    }));
}

/** The llm-pi-ai provider profile for one route, pointing at this plugin's
 * loopback gateway on the dsh web port. Static header placeholders satisfy
 * pi-ai's client-side auth requirement; the gateway injects the real Factory
 * credential and the route's mandatory headers per request. */
// Each client SDK appends a different suffix to baseURL: Anthropic's appends
// `/v1/messages`, so that route's baseURL stops at `/a`; the OpenAI chat SDK
// appends `/chat/completions`, so the generic route keeps `/o/v1`; the
// responses client appends `/responses`, so the openai route takes
// `/openai/v1`. Getting this wrong lands the request on an unmatched path,
// which dsh's /api gateway answers 401 — surfacing as a bogus "API key
// invalid".
const GATEWAY_SUB = { anthropic: "a", generic: "o/v1", openai: "openai/v1" };

export function buildProviderEntry(route, { port, gatewayPrefix, allowlist = [] }) {
  const spec = ROUTES[route];
  if (spec === undefined) return undefined;
  const entry = {
    api: spec.api,
    baseURL: `http://127.0.0.1:${port}${gatewayPrefix}/${GATEWAY_SUB[route]}`,
    displayName: spec.displayName,
    defaultContextWindow: spec.defaultContextWindow,
    defaultMaxTokens: spec.defaultMaxTokens,
    models: buildModelEntries(route, allowlist),
  };
  if (route === "generic") {
    // Same reasoning-capable compat default the shipping commandcode-provider
    // route uses for an unrecognized openai-completions endpoint.
    entry.compat = { thinkingFormat: "openai", supportsReasoningEffort: true };
    entry.headers = { authorization: "Bearer factory-gateway" };
  } else if (route === "openai") {
    // The responses client needs no compat: its defaults already do the right
    // thing (strict off, max_output_tokens on, openai session affinity).
    entry.headers = { authorization: "Bearer factory-gateway" };
  } else {
    entry.headers = { "x-api-key": "factory-gateway" };
  }
  return entry;
}

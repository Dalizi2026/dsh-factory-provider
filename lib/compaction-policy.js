// Plugin defaults approved on 2026-10-06. Keep these separate from the
// unmodified Droid budget snapshot: vendor formulas are adapted to Factory,
// not measured server limits or claims of an optimal cost/quality threshold.
import { FACTORY_MODEL_LIMITS } from "./model-limits.js";

export const MIN_COMPACTION_TOKENS = 16384;
// Accept saved thresholds for retired IDs during upgrades, without registering
// them as callable models or applying their overrides to the replacement.
export const RETIRED_COMPACTION_CEILINGS = Object.freeze({
  "deepseek-v4-pro": 843392,
  "deepseek-v4-flash-0731": 843392,
});
const LEGACY_FIELDS = {
  "claude-opus-5-5": "opus55CompactionTokens",
  "claude-sonnet-5-5": "sonnet55CompactionTokens",
  "glm-5.3-flash": "glmFlashCompactionTokens",
};

export function modelCompactionPolicy(id) {
  const limits = FACTORY_MODEL_LIMITS[id];
  if (!limits) return undefined;
  let defaultThreshold = limits.defaultCompactionLimit, headroomTokens = 0;
  let source = "droid", nativeContextWindow;
  if (id === "claude-opus-5-5" || id === "claude-sonnet-5-5") {
    defaultThreshold = 400000; source = "selected";
  } else if (id === "claude-opus-5-5-fast") {
    source = "selected";
  } else if (id.startsWith("claude-") && !id.startsWith("claude-haiku")) {
    defaultThreshold = id === "claude-sonnet-4-6" ? 910000 : 850000;
    headroomTokens = 13000; source = "claude-adapted";
  } else if (id.startsWith("glm-5.3")) {
    defaultThreshold = id.endsWith("flash") ? 900000 : 890000;
    headroomTokens = 13000; source = "zcode-factory-budget";
  } else if (id === "qwen3.8-max") {
    defaultThreshold = 118000; headroomTokens = 13000;
    source = "qwen-adapted"; nativeContextWindow = 1000000;
  } else if (id === "kimi-k3") {
    defaultThreshold = 190000; source = "kimi-adapted";
    nativeContextWindow = 1000000;
  } else if (id.startsWith("minimax-")) {
    defaultThreshold = id === "minimax-m3" ? 420000 : 185000;
    headroomTokens = 2048; source = "minimax-local-adapted";
    if (id === "minimax-m3") nativeContextWindow = 1000000;
  } else if (id.startsWith("deepseek-")) {
    defaultThreshold = 830000; headroomTokens = 65536;
    source = "dsh-default-adapted";
  } else if (id === "nemotron-3-ultra") {
    nativeContextWindow = 1000000;
  }
  const maxThreshold = Math.min(limits.maxInputTokens,
    limits.contextWindow - limits.maxOutputTokens) - headroomTokens;
  return {
    defaultThreshold: Math.min(defaultThreshold, maxThreshold), maxThreshold,
    headroomTokens, source, legacyField: LEGACY_FIELDS[id],
    contextWindow: limits.contextWindow, maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens, nativeContextWindow,
    smallerChannel: nativeContextWindow !== undefined && limits.contextWindow < nativeContextWindow * 0.75,
    effortDependent: Boolean(limits.inputByEffort),
  };
}

function read(raw) {
  return raw && typeof raw.get === "function" ? raw.get() : raw;
}

/** Reject bad persisted values, including unknown model IDs. Runtime still
 * clamps against a smaller host window, output reservation and Haiku effort. */
export function validateModelCompactionTokens(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("modelCompactionTokens must be a model/token dictionary");
  }
  for (const [id, tokens] of Object.entries(values)) {
    const policy = modelCompactionPolicy(id);
    const ceiling = policy?.maxThreshold ?? (Object.hasOwn(RETIRED_COMPACTION_CEILINGS, id) ? RETIRED_COMPACTION_CEILINGS[id] : undefined);
    if (ceiling === undefined || !Number.isInteger(tokens) || tokens < MIN_COMPACTION_TOKENS || tokens > ceiling) {
      throw new TypeError(`Invalid compaction threshold for ${id}; expected ${MIN_COMPACTION_TOKENS}..${ceiling ?? "known model"}`);
    }
  }
  return values;
}

export function resolveModelCompactionPolicy(id, source = {}) {
  const policy = modelCompactionPolicy(id);
  if (!policy) return undefined;
  const overrides = read(source.modelCompactionTokens) ?? {};
  const custom = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
  const legacy = policy.legacyField ? read(source[policy.legacyField]) : undefined;
  const requested = custom ?? legacy ?? policy.defaultThreshold;
  // Fail closed for old/manual malformed configuration; schema rejects new
  // writes. A valid explicit smaller legacy choice survives an upgrade.
  const thresholdTokens = Number.isInteger(requested) && requested >= MIN_COMPACTION_TOKENS
    ? Math.min(requested, policy.maxThreshold) : policy.defaultThreshold;
  return { ...policy, thresholdTokens };
}

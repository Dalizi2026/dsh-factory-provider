// Static budget snapshot from @factory/cli-darwin-arm64 0.233.0 (2026-10-04).
// CLI input/output envelopes are adapter budgets, not measured server limits.
// Source: https://registry.npmjs.org/@factory/cli-darwin-arm64/-/cli-darwin-arm64-0.233.0.tgz
export const FACTORY_LIMITS_VERSION = "0.233.0";
export const FACTORY_MODEL_LIMITS = Object.freeze({
  "claude-opus-5-5": {
    "contextWindow": 1000000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 872000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-5-5-fast": {
    "contextWindow": 1000000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 872000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-4-8": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-4-8-fast": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-5": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-5-fast": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-opus-4-7": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-sonnet-5-5": {
    "contextWindow": 1000000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 872000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-sonnet-5": {
    "contextWindow": 1000000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 872000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-sonnet-4-6": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 931000,
    "maxOutputTokens": 64000,
    "defaultCompactionLimit": 250000
  },
  "claude-fable-5.1": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-fable-5": {
    "contextWindow": 995000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 867000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "claude-haiku-4-5-20251001": {
    "contextWindow": 200000,
    "capacityKind": "model-context",
    "maxInputTokens": 180000,
    "maxOutputTokens": 32000,
    "defaultCompactionLimit": 180000,
    "inputByEffort": {
      "off": 180000,
      "low": 153904,
      "medium": 145712,
      "high": 133424
    }
  },
  "glm-5.3-flash": {
    "contextWindow": 1048576,
    "capacityKind": "cli-total",
    "maxInputTokens": 917504,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "inkling": {
    "contextWindow": 1040000,
    "capacityKind": "cli-total",
    "maxInputTokens": 1007232,
    "maxOutputTokens": 32768,
    "defaultCompactionLimit": 250000
  },
  "qwen3.8-max": {
    "contextWindow": 262144,
    "capacityKind": "cli-total",
    "maxInputTokens": 131072,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 131072
  },
  "nemotron-3-ultra": {
    "contextWindow": 202000,
    "capacityKind": "cli-total",
    "maxInputTokens": 136464,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 136464
  },
  "glm-5.3": {
    "contextWindow": 1040000,
    "capacityKind": "cli-total",
    "maxInputTokens": 908928,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "kimi-k3": {
    "contextWindow": 262144,
    "capacityKind": "cli-total",
    "maxInputTokens": 196608,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 196608
  },
  "minimax-m3": {
    "contextWindow": 512000,
    "capacityKind": "cli-total",
    "maxInputTokens": 448000,
    "maxOutputTokens": 64000,
    "defaultCompactionLimit": 250000
  },
  "minimax-m2.7": {
    "contextWindow": 260600,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 196600,
    "maxOutputTokens": 64000,
    "defaultCompactionLimit": 196600
  },
  "deepseek-v4-pro": {
    "contextWindow": 1040000,
    "capacityKind": "cli-total",
    "maxInputTokens": 908928,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "deepseek-v4-flash-0731": {
    "contextWindow": 1040000,
    "capacityKind": "cli-total",
    "maxInputTokens": 908928,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "gpt-6-astra": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-6-sol": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-6-luna": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.6-sol": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.6-sol-fast": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.6-terra": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.6-luna": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.5": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.5-fast": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.4": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.4-fast": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.4-mini": {
    "contextWindow": 400000,
    "capacityKind": "cli-total",
    "maxInputTokens": 272000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.4-mini-fast": {
    "contextWindow": 400000,
    "capacityKind": "cli-total",
    "maxInputTokens": 272000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.3-codex": {
    "contextWindow": 400000,
    "capacityKind": "cli-total",
    "maxInputTokens": 272000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.2": {
    "contextWindow": 400000,
    "capacityKind": "cli-total",
    "maxInputTokens": 272000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  }
});

/** Unknown Haiku effort uses the smallest supported input budget. */
export function factoryModelLimits(provider, model, effort) {
  const route = model?.startsWith("claude-") ? "factory-a" : model?.startsWith("gpt-") ? "factory-o" : "factory-g";
  if (provider !== route) return undefined;
  const limits = FACTORY_MODEL_LIMITS[model];
  if (!limits) return undefined;
  const input = limits.inputByEffort
    ? limits.inputByEffort[effort] ?? Math.min(...Object.values(limits.inputByEffort))
    : limits.maxInputTokens;
  return { ...limits, maxInputTokens: input, defaultCompactionLimit: Math.min(limits.defaultCompactionLimit, input) };
}

/** Preserve smaller explicit requests; cap only budgets above the CLI ceiling. */
export function clampFactoryOutputTokens(provider, parsed) {
  const limits = factoryModelLimits(provider, parsed?.model);
  if (!limits) return parsed;
  const fields = provider === "factory-o" ? ["max_output_tokens"] : ["max_tokens", "max_completion_tokens"];
  for (const field of fields) {
    if (Number.isInteger(parsed[field]) && parsed[field] > limits.maxOutputTokens) parsed[field] = limits.maxOutputTokens;
  }
  return parsed;
}

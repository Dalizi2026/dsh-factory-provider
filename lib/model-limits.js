// Static adapter budgets extracted from @factory/cli-darwin-arm64 0.241.0 (2026-10-14).
// Budget envelopes are not measured physical context or server limits.
export const FACTORY_LIMITS_VERSION = "0.241.0";
export const FACTORY_MODEL_LIMITS = Object.freeze({
  "gemini-4-argon": {
    "contextWindow": 1000000,
    "capacityKind": "cli-total",
    "maxInputTokens": 934464,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
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
  "deepseek-v4.1-flash": {
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
  "gpt-6.1-sol": {
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
  },
  "claude-haiku-5-5": {
    "contextWindow": 1000000,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 872000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "mistral-large-4": {
    "contextWindow": 588288,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 524288,
    "maxOutputTokens": 64000,
    "defaultCompactionLimit": 250000
  },
  "mistral-medium-3.5": {
    "contextWindow": 256000,
    "capacityKind": "cli-total",
    "maxInputTokens": 192000,
    "maxOutputTokens": 64000,
    "defaultCompactionLimit": 192000
  },
  "glm-5.2": {
    "contextWindow": 1040000,
    "capacityKind": "cli-total",
    "maxInputTokens": 908928,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "glm-5.2-fast": {
    "contextWindow": 524288,
    "capacityKind": "cli-total",
    "maxInputTokens": 393216,
    "maxOutputTokens": 131072,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.5-pro": {
    "contextWindow": 1050000,
    "capacityKind": "cli-total",
    "maxInputTokens": 922000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gpt-5.3-codex-fast": {
    "contextWindow": 400000,
    "capacityKind": "cli-total",
    "maxInputTokens": 272000,
    "maxOutputTokens": 128000,
    "defaultCompactionLimit": 250000
  },
  "gemini-3.1-pro-preview": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "gemini-3.8-flash": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "gemini-3.7-flash": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "gemini-3.6-flash": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "gemini-3.5-flash": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "gemini-3-flash-preview": {
    "contextWindow": 1065536,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 1000000,
    "maxOutputTokens": 65536,
    "defaultCompactionLimit": 250000
  },
  "grok-4.5": {
    "contextWindow": 263356,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 200000,
    "maxOutputTokens": 63356,
    "defaultCompactionLimit": 200000
  },
  "grok-4.6": {
    "contextWindow": 263356,
    "capacityKind": "cli-budget-envelope",
    "maxInputTokens": 200000,
    "maxOutputTokens": 63356,
    "defaultCompactionLimit": 200000
  },
  "grok-4.7": {
    "contextWindow": 500000,
    "capacityKind": "cli-total",
    "maxInputTokens": 436644,
    "maxOutputTokens": 63356,
    "defaultCompactionLimit": 250000
  }
});

/** Unknown Haiku effort uses the smallest supported input budget. */
export function factoryModelLimits(provider, model, effort) {
  const route = model?.startsWith("claude-") ? "factory-a" : model?.startsWith("gpt-") ? "factory-o" : model?.startsWith("gemini-") ? "factory-google" : model?.startsWith("grok-") ? "factory-xai" : "factory-g";
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
  if (provider === "factory-google" && parsed.generationConfig?.maxOutputTokens > limits.maxOutputTokens) {
    parsed.generationConfig.maxOutputTokens = limits.maxOutputTokens;
  }
  const fields = ["factory-o", "factory-xai"].includes(provider) ? ["max_output_tokens"] : ["max_tokens", "max_completion_tokens"];
  for (const field of fields) {
    if (Number.isInteger(parsed[field]) && parsed[field] > limits.maxOutputTokens) parsed[field] = limits.maxOutputTokens;
  }
  return parsed;
}

import { DROID_SYSTEM_LINE } from './sanitize.js';
import { modelPreset } from './model-presets.js';
import { streamGoogleNative } from './google-stream.js';

/** Factory's native Google endpoint accepts the SDK contents unchanged.
 * Signed parts, binary data and function arguments must never be rewritten. */
export function normalizeGooglePayload(parsed) {
  const preset = modelPreset(parsed.model);
  const config = parsed.generationConfig ??= {};
  config.maxOutputTokens ??= 65536;
  config.thinkingConfig ??= { includeThoughts: true, thinkingLevel: (preset?.defaultEffort ?? 'high').toUpperCase() };
  if (parsed.model === 'gemini-4-argon') {
    for (const field of ['temperature', 'topP', 'topK']) delete config[field];
  } else {
    config.temperature ??= 1;
    config.topP ??= 0.95;
    config.topK ??= 64;
  }
  const system = typeof parsed.systemInstruction === 'string'
    ? { parts: [{ text: parsed.systemInstruction }] } : parsed.systemInstruction ?? { parts: [] };
  if (!system.parts?.[0]?.text?.startsWith(DROID_SYSTEM_LINE)) {
    system.parts = [{ text: DROID_SYSTEM_LINE }, ...(system.parts ?? [])];
  }
  parsed.systemInstruction = system;
}

/** Old DSH releases restrict the configured profile to three protocols. Keep
 * its isolated factory-google profile valid, and dispatch only its calls to
 * the plugin's native transport. No host SDK files or global registries change. */
export function scopeGoogleSdk(snapshot, options) {
  if (options.provider !== 'factory-google' || !snapshot.models) return snapshot;
  const models = new Proxy(snapshot.models, { get(target, key) {
    if (key !== 'streamSimple') {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return (model, context, sdkOptions) => streamGoogleNative(
      { ...model, api: 'google-generative-ai' }, context, sdkOptions);
  } });
  return { ...snapshot, models };
}

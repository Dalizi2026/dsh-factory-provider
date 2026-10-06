// Factory-only guard around DSH's public compaction service. History commits,
// summary framing, cancellation and tool-pair validation remain owned by DSH.
// No prompts or credentials are retained in diagnostics.
import { ROUTES, servableModels } from "./catalog.js";
import { factoryModelLimits, FACTORY_LIMITS_VERSION } from "./model-limits.js";
import { resolveModelCompactionPolicy } from "./compaction-policy.js";
import { installFactoryRequestRecovery } from "./request-recovery.js";
const PATCH = Symbol.for("dsh-factory-provider.context-optimization");
const SUMMARY_REJECTED = /summary is not smaller than the shadowed content/;

/** Compaction models verified to read images on their own Factory route.
 *
 *  The plugin declares input:["text","image"] for every model, so DSH will send
 *  images to any of them. Summarising an image-bearing checkpoint with a model
 *  that cannot actually see the image would spend a full-history call before the
 *  rejection machinery notices, so anything not listed here stays on Claude for
 *  image histories.
 *
 *  Add an entry only after reading a unique value back out of a real image, not
 *  merely after a 200 response. glm-5.3-flash passed that test on 2026-10-04. */
const IMAGE_VERIFIED_SUMMARY_MODELS = new Set(["glm-5.3-flash"]);
const TARGET_RATIO = 0.65;
const MIN_REDUCTION = 8192;

function value(raw, fallback) {
  const result = raw && typeof raw.get === "function" ? raw.get() : raw;
  return result === undefined ? fallback : result;
}

function options(source = {}) {
  return {
    enabled: value(source.enabled, true) !== false,
    alignment: value(source.factoryContextAlignment, true) !== false,
    requestRecovery: value(source.factoryRequestRecovery, true) !== false,
    claudeOptimization: value(source.anthropicContextOptimization, true) !== false,
    opusThreshold: value(source.opus55CompactionTokens, 400000),
    sonnetThreshold: value(source.sonnet55CompactionTokens, 400000),
    glmFlashThreshold: value(source.glmFlashCompactionTokens, 900000),
    modelCompactionTokens: value(source.modelCompactionTokens, {}),
    headroom: value(source.anthropicCompactionHeadroomTokens, 16384),
    summaryMaxTokens: value(source.anthropicSummaryMaxTokens, 4096),
    summaryModel: value(source.anthropicSummaryModel, ""),
    routes: value(source.routes, ["anthropic", "generic", "openai"]),
    allowlist: value(source.modelAllowlist, []),
  };
}

function targetOf(agent) {
  return agent.session?.requestHeader?.()?.config ?? agent.options;
}

function isFactory(agent, settings) {
  return settings.enabled && settings.claudeOptimization && settings.routes.includes("anthropic") && targetOf(agent)?.provider === "factory-a";
}

function alignedLimits(agent, settings, info) {
  if (!settings.enabled || !settings.alignment) return undefined;
  const target = targetOf(agent);
  const route = Object.keys(ROUTES).find(route => ROUTES[route].key === target?.provider);
  if (!route || !settings.routes.includes(route) || !servableModels(route).some(m => m.id === target.model)) return undefined;
  return factoryModelLimits(target.provider, target.model, target.reasoningEffort ?? info?.reasoning?.defaultEffort);
}

/** CLI input budgets already reserve their output budget. Do not subtract it
 * twice. Respect a smaller host window and any larger explicit output reserve.
 * Per-model safety space is subtracted after the input envelope.
 * Legacy headroom is used by summaries and compatibility fallback. */
export function alignedCompactionBudget({ limits, contextWindow, maxTokens, thresholdTokens, headroomTokens = 0 }) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0 ||
      !Number.isInteger(maxTokens) || maxTokens < 0 ||
      !Number.isInteger(thresholdTokens) || thresholdTokens <= 0 ||
      !Number.isInteger(headroomTokens) || headroomTokens < 0 ||
      !Number.isInteger(limits?.maxInputTokens) || limits.maxInputTokens <= 0 ||
      !Number.isInteger(limits?.maxOutputTokens) || limits.maxOutputTokens <= 0) {
    throw new Error("Factory context alignment: invalid compaction budget");
  }
  const inputBudget = Math.min(limits.maxInputTokens, contextWindow - maxTokens);
  const threshold = Math.min(thresholdTokens, inputBudget - headroomTokens);
  if (threshold <= 0) throw new Error("Factory context alignment: no safe input budget");
  return { threshold, target: Math.floor(threshold * TARGET_RATIO), inputBudget };
}

/** Never enlarge the provider's declared context or the request output budget. */
export function compactionBudget({ contextWindow, maxTokens = 0, headroomTokens = 16384, thresholdRatio = 0.8 }) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0 ||
      !Number.isInteger(maxTokens) || maxTokens < 0 ||
      !Number.isInteger(headroomTokens) || headroomTokens < 0 ||
      !Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio > 1) {
    throw new Error("Factory context optimization: invalid compaction budget");
  }
  const threshold = Math.floor(Math.min(contextWindow * thresholdRatio, contextWindow - maxTokens - headroomTokens));
  if (threshold <= 0) throw new Error("Factory context optimization: no safe input budget");
  return { threshold, target: Math.floor(threshold * TARGET_RATIO) };
}

/** Select only a model already exposed by the enabled Factory providers. */
export function resolveSummaryTarget(source = {}, { fallbackToNative = false } = {}) {
  const settings = options(source);
  if (!settings.summaryModel) return undefined;
  for (const [route, spec] of Object.entries(ROUTES)) {
    const model = servableModels(route).find(model => `${spec.key}/${model.id}` === settings.summaryModel);
    if (model && settings.routes.includes(route) &&
        (!settings.allowlist.length || settings.allowlist.includes(model.id))) {
      return { provider: spec.key, model: model.id };
    }
  }
  // The shipped cheap-model preference must not disable compaction when its
  // route/model is hidden. Other unavailable selections remain explicit errors.
  if (fallbackToNative && settings.summaryModel === "factory-g/glm-5.3-flash") return undefined;
  const error = new Error("Compaction model is unavailable: enable its Factory route and include the model in the model selection, or choose the DSH default.");
  error.code = "SUMMARY_MODEL_UNAVAILABLE";
  throw error;
}

/** Price nodes in the same approximate scale as reported prompt occupancy.
 * Output is excluded when deriving the scale; it still occupies context and
 * participates in the pressure/target calculation, like DSH's native meter.
 * New tool results are included in the denominator, making this conservative
 * until the next normal request supplies fresh usage. */
export function calibratedScale(measurement, toolsTokens, assistantTokens = 0) {
  const surfaceTokens = measurement.nodes.reduce((sum, node) => sum + node.tokens, 0);
  const usage = measurement.baseline?.kind === "usage" ? measurement.baseline.usage : undefined;
  const output = usage?.outputTokens ?? 0;
  const estimatedInput = toolsTokens + surfaceTokens - (usage ? assistantTokens : 0);
  const inputPressure = measurement.totalTokens - output;
  return Math.max(1, inputPressure / Math.max(1, estimatedInput));
}

/** Select a substantial prefix, stopping only at a complete tool-pair boundary.
 * Keep at least one surface node and a useful recent tail. Never rewrite a
 * system prompt. seqs are metadata, not serialized message bodies. */
export function selectCompactionRange(session, measurement, { target, scale, minimumReduction = MIN_REDUCTION }) {
  const nodes = measurement.nodes;
  const seqs = session.surface.nodes;
  if (nodes.length !== seqs.length || nodes.some((n, i) => n.seq !== seqs[i])) {
    throw new Error("Factory context optimization: token-meter surface mismatch");
  }
  if (!Number.isFinite(scale) || scale < 1 || nodes.some(n => !Number.isFinite(n.tokens) || n.tokens < 0)) {
    throw new Error("Factory context optimization: invalid node pricing");
  }
  const first = session.eventAt(seqs[0])?.type === "system/message" ? 1 : 0;
  if (nodes.length - first < 2) return null;
  const history = nodes.slice(first).reduce((sum, node) => sum + node.tokens * scale, 0);
  const retainMinimum = Math.min(4096, history / 4);
  const reduction = Math.max(minimumReduction, measurement.totalTokens - target);
  let removed = 0;
  let pending = 0;
  let selected;
  // Fold ALL nodes so an orphaned result never becomes an apparent safe cut.
  for (let i = 0; i < nodes.length; i++) {
    const event = session.eventAt(nodes[i].seq);
    if (!event || event.seq !== nodes[i].seq) throw new Error("Factory context optimization: missing surface event");
    if (event.type === "assistant/message") {
      pending += event.data.message.content.filter(block => block.type === "tool-call").length;
    } else if (event.type === "tool/result") {
      pending--;
    }
    if (pending < 0) throw new Error("Factory context optimization: orphaned tool result");
    if (i < first) continue;
    removed += nodes[i].tokens * scale;
    if (pending === 0 && i < nodes.length - 1 && history - removed >= retainMinimum && removed >= reduction && !selected) {
      selected = { start: nodes[first].seq, end: nodes[i].seq, seqs: seqs.slice(first, i + 1), removedTokens: Math.floor(removed) };
    }
  }
  return selected ?? null;
}

function lastAssistant(session, measurement) {
  for (let i = measurement.nodes.length - 1; i >= 0; i--) {
    const node = measurement.nodes[i];
    const event = session.eventAt(node.seq);
    if (event?.type === "assistant/message" && event.data.usage) return { seq: node.seq, tokens: node.tokens };
  }
  return { seq: null, tokens: 0 };
}

function supported(engine, agent) {
  return engine?.constructor?.name === "BasicCompactionEngine" &&
    typeof engine.compactIfNeeded === "function" && typeof engine.compactRegion === "function" &&
    typeof engine.summarize === "function" && typeof engine.config?.thresholdRatio === "number" &&
    Number.isInteger(engine.config.maxTokens) && engine.config.maxTokens > 0 &&
    Array.isArray(engine.config.modelPolicies) && typeof agent.ctx?.get === "function" &&
    typeof agent.session?.requestHeader === "function" && typeof agent.session.eventAt === "function";
}

const originalOf = object => object?.[Symbol.for("cordis.original")] ?? object;

/** Desktop presets isolate compaction in a sibling group. Resolve only
 * services admitted by the dispatch's own Cordis/DSH scope filter; never take
 * another session's service just because it appears in the registry. */
function resolveEngine(ctx, agent, carrier) {
  const direct = originalOf(agent.ctx?.get?.("compaction"));
  const filter = carrier?.[Symbol.for("cordis.filter")];
  if (typeof filter !== "function" || typeof ctx.registry?.values !== "function") {
    return { engine: direct, reason: "compaction-service-not-visible" };
  }
  const candidates = new Set(direct ? [direct] : []);
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers ?? []) {
      if (fiber.state !== 2) continue;
      const engine = originalOf(fiber.store?.compaction?.value);
      if (engine?.ctx && filter.call(carrier, engine.ctx)) candidates.add(engine);
    }
  }
  // Prefer the nearest composition when a child Agent also admits listeners
  // from an enclosing scope. Equally close services are ambiguous: fail safe.
  const ancestors = new Map();
  for (let fiber = originalOf(agent.ctx?.fiber); fiber && !ancestors.has(fiber); fiber = originalOf(fiber.parent?.fiber)) {
    ancestors.set(fiber, ancestors.size);
  }
  const distance = engine => {
    const visited = new Set();
    for (let fiber = originalOf(engine.ctx?.fiber); fiber && !visited.has(fiber); fiber = originalOf(fiber.parent?.fiber)) {
      if (ancestors.has(fiber)) return ancestors.get(fiber);
      visited.add(fiber);
    }
    return Infinity;
  };
  const ranked = [...candidates].map(engine => ({ engine, distance: distance(engine) }));
  const closest = Math.min(...ranked.map(candidate => candidate.distance));
  const selected = ranked.filter(candidate => candidate.distance === closest);
  return selected.length === 1 ? { engine: selected[0].engine }
    : { reason: selected.length ? "compaction-service-ambiguous" : "compaction-service-not-visible" };
}

/** Install before the native pre-step listener. Get the AGENT-scoped service;
 * the host's compaction service is intentionally absent in current DSH. */
export function installContextOptimization(ctx, readConfig, status = {}, record = () => {}) {
  const patches = new Map();
  const agentEngines = new WeakMap();
  const owner = {};
  let recovery;
  status.state = "waiting";
  status.engines = 0;
  status.limitsVersion = FACTORY_LIMITS_VERSION;
  const emit = data => record({ route: "plugin", event: "context-optimization", ...data });
  const restore = (engine, patch) => {
    if (engine.compactIfNeeded === patch.compact) {
      if (patch.ownCompact) engine.compactIfNeeded = patch.originalCompact;
      else delete engine.compactIfNeeded;
    }
    if (engine.summarize === patch.summarize) {
      if (patch.ownSummarize) engine.summarize = patch.originalSummarize;
      else delete engine.summarize;
    }
    if (engine[PATCH]?.owner === owner) delete engine[PATCH];
    patches.delete(engine);
    status.engines = patches.size;
  };
  const attach = (agent, carrier, ready = true) => {
    if (!agent) return;
    const initial = options(readConfig());
    if (!initial.enabled || (!initial.alignment && !initial.claudeOptimization && !initial.requestRecovery)) { status.state = "disabled"; return; }
    const { engine, reason } = resolveEngine(ctx, agent, carrier);
    if (!supported(engine, agent)) {
      if (isFactory(agent, initial) || alignedLimits(agent, initial)) {
        status.state = !engine && !ready ? "waiting" : "unsupported";
        status.reason = reason ?? "unsupported-compaction-interface";
      }
      return;
    }
    if (engine[PATCH]) {
      if (engine[PATCH].owner === owner) {
        engine[PATCH].agents.add(agent);
        agentEngines.set(agent, engine);
      }
      return;
    }
    const originalCompact = engine.compactIfNeeded;
    const originalSummarize = engine.summarize;
    const failures = new WeakMap();
    const committedAnchors = new WeakMap();
    const patch = {
      owner, agents: new Set([agent]), originalCompact, originalSummarize,
      ownCompact: Object.hasOwn(engine, "compactIfNeeded"),
      ownSummarize: Object.hasOwn(engine, "summarize"),
    };
    patch.summarize = async function(input, currentAgent, signal) {
      const settings = options(readConfig());
      if (!isFactory(currentAgent, settings)) return recovery.summarize(input, currentAgent, signal,
        nextInput => originalSummarize.call(this, nextInput, currentAgent, signal));
      const summaryTarget = resolveSummaryTarget(readConfig(), { fallbackToNative: true });
      if (!summaryTarget && settings.summaryModel) {
        emit({ action: "summary-model-fallback", sessionId: currentAgent.session.id,
          unavailableModel: settings.summaryModel, strategy: "native-dsh" });
      }
      let summaryCap = settings.summaryMaxTokens;
      if (summaryTarget) {
        // Image-bearing checkpoints go to Claude, or to a non-Claude model that
        // has been verified to read images on its own route. The check is a
        // substring on the DSH-side block shape, which is what the summariser
        // receives; the generic route's wire form (image_url) does not appear
        // here.
        const hasImage = JSON.stringify(input.messages ?? []).includes('"type":"image"');
        const imageCapable = summaryTarget.provider === "factory-a" || IMAGE_VERIFIED_SUMMARY_MODELS.has(summaryTarget.model);
        if (hasImage && !imageCapable) {
          const error = new Error("Selected compaction model has unverified image support; choose a Claude compaction model, a verified multimodal model, or the DSH default for this conversation.");
          error.code = "UNSUPPORTED_SUMMARY_CONTENT";
          throw error;
        }
        const info = await this.ctx.llm.resolveModelInfo(summaryTarget.provider, summaryTarget.model, signal);
        signal?.throwIfAborted();
        const capacity = info?.context?.contextWindow;
        if (!Number.isInteger(capacity) || capacity <= 0) {
          const error = new Error("Selected compaction model has no valid context capacity.");
          error.code = "SUMMARY_MODEL_UNAVAILABLE";
          throw error;
        }
        if (Number.isInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0) summaryCap = Math.min(summaryCap, info.defaultMaxTokens);
        const meter = currentAgent.ctx.get("tokenMeter");
        const measurement = meter.measure(currentAgent.session);
        const toolsTokens = input.tools?.length ? Math.ceil(JSON.stringify(input.tools).length / 4) + 4 : 0;
        const sessionTools = currentAgent.session.requestHeader()?.tools ?? [];
        const sessionToolsTokens = sessionTools.length ? Math.ceil(JSON.stringify(sessionTools).length / 4) + 4 : 0;
        const scale = calibratedScale(measurement, sessionToolsTokens, lastAssistant(currentAgent.session, measurement).tokens);
        const estimatedInput = Math.ceil(JSON.stringify(input.messages ?? []).length / 4) * scale + toolsTokens * scale;
        const limits = factoryModelLimits(summaryTarget.provider, summaryTarget.model, info.reasoning?.defaultEffort);
        const inputBudget = Math.min(limits?.maxInputTokens ?? Infinity, capacity - summaryCap);
        if (estimatedInput + settings.headroom >= inputBudget) {
          const error = new Error("Selected compaction model has insufficient estimated context capacity; choose a larger-context model or the DSH default.");
          error.code = "SUMMARY_CONTEXT_TOO_SMALL";
          throw error;
        }
      }
      // A detached config view avoids mutating the frozen native config and
      // avoids changing another agent while summaries run concurrently.
      const facade = Object.create(this);
      const nativeCtx = this.ctx;
      const llm = nativeCtx.llm;
      const summaryCtx = Object.create(nativeCtx);
      const summaryLlm = Object.create(llm);
      Object.defineProperty(summaryLlm, "stream", { value: function(request) {
        if (request.purpose !== "compaction") return llm.stream(request);
        const messages = [...request.messages];
        const last = messages.at(-1);
        if (last?.role === "user" && Array.isArray(last.content)) {
          // Add the size instruction only to DSH's appended summarization
          // instruction, never to historical messages or the normal request.
          messages[messages.length - 1] = { ...last, content: [...last.content, {
            type: "text",
            text: `Keep the checkpoint concise and within ${Math.floor(request.maxTokens * 0.6)} output tokens. Prioritize constraints, current state, decisions, and next actions; omit redundant narrative.`,
          }] };
        }
        return llm.stream({ ...request, messages });
      } });
      Object.defineProperty(summaryCtx, "llm", { value: summaryLlm });
      Object.defineProperties(facade, {
        ctx: { value: summaryCtx },
        config: { value: {
          ...this.config,
          maxTokens: Math.min(this.config.maxTokens, summaryCap),
          ...(summaryTarget ? { summarizationProvider: summaryTarget.provider, summarizationModel: summaryTarget.model } : {}),
          modelPolicies: this.config.modelPolicies.map(policy => ({
            ...policy,
            ...(policy.provider === "factory-a" ? {
              maxTokens: Math.min(policy.maxTokens ?? this.config.maxTokens, summaryCap),
              ...(summaryTarget ? { summarizationProvider: summaryTarget.provider, summarizationModel: summaryTarget.model } : {}),
            } : {}),
          })),
        } },
      });
      return recovery.summarize(input, currentAgent, signal,
        nextInput => originalSummarize.call(facade, nextInput, currentAgent, signal));
    };
    patch.compact = async function(currentAgent, trigger, signal) {
      const settings = options(readConfig());
      // Overflow recovery and other providers keep the native, validated path.
      const alignment = alignedLimits(currentAgent, settings);
      if ((!isFactory(currentAgent, settings) && !alignment) || trigger !== "pressure") {
        return originalCompact.call(this, currentAgent, trigger, signal);
      }
      signal?.throwIfAborted();
      const target = targetOf(currentAgent);
      const meter = currentAgent.ctx.get("tokenMeter");
      const llm = currentAgent.ctx.get("llm");
      if (typeof meter?.measure !== "function" || typeof llm?.resolveModelInfo !== "function") {
        status.state = "unsupported";
        return originalCompact.call(this, currentAgent, trigger, signal);
      }
      const info = await llm.resolveModelInfo(target.provider, target.model, signal);
      signal?.throwIfAborted();
      // Older/custom adapters without context metadata retain native behavior.
      if (!Number.isInteger(info?.context?.contextWindow)) {
        status.state = "unsupported";
        return originalCompact.call(this, currentAgent, trigger, signal);
      }
      const policy = this.config.modelPolicies.find(p => p.provider === target.provider && p.model === target.model);
      const limits = alignedLimits(currentAgent, settings, info);
      const modelPolicy = limits ? resolveModelCompactionPolicy(target.model, {
        modelCompactionTokens: settings.modelCompactionTokens,
        opus55CompactionTokens: settings.opusThreshold,
        sonnet55CompactionTokens: settings.sonnetThreshold,
        glmFlashCompactionTokens: settings.glmFlashThreshold,
      }) : undefined;
      const thresholdTokens = modelPolicy?.thresholdTokens;
      const budget = limits ? alignedCompactionBudget({
        limits, contextWindow: info.context.contextWindow,
        maxTokens: target.maxTokens ?? info.defaultMaxTokens ?? limits.maxOutputTokens,
        headroomTokens: modelPolicy.headroomTokens,
        thresholdTokens: policy?.thresholdRatio === undefined ? thresholdTokens
          : Math.min(thresholdTokens, Math.floor(info.context.contextWindow * policy.thresholdRatio)),
      }) : compactionBudget({
        contextWindow: info.context.contextWindow,
        maxTokens: target.maxTokens ?? info.defaultMaxTokens ?? 0,
        headroomTokens: settings.headroom,
        thresholdRatio: policy?.thresholdRatio ?? this.config.thresholdRatio,
      });
      let measurement = meter.measure(currentAgent.session);
      status.state = "active";
      status.lastBudget = { provider: target.provider, model: target.model, threshold: budget.threshold,
        inputBudget: budget.inputBudget, outputBudget: target.maxTokens ?? info.defaultMaxTokens ?? limits?.maxOutputTokens,
        policy: limits ? modelPolicy.source : "dsh-compatible" };
      if (measurement.totalTokens < budget.threshold) return null;
      const pruner = this.ctx.get?.("toolResultPruner") ?? currentAgent.ctx.get("toolResultPruner");
      if (pruner?.pruneSession) {
        pruner.pruneSession(currentAgent.session);
        measurement = meter.measure(currentAgent.session);
        if (measurement.totalTokens < budget.threshold) return null;
      }
      const assistant = lastAssistant(currentAgent.session, measurement);
      const anchor = `${target.model}:${assistant.seq ?? "none"}`;
      if (committedAnchors.get(currentAgent.session) === anchor) return null;
      const tools = currentAgent.session.requestHeader()?.tools ?? [];
      const toolsTokens = tools.length ? Math.ceil(JSON.stringify(tools).length / 4) + 4 : 0;
      const scale = calibratedScale(measurement, toolsTokens, assistant.tokens);
      const range = selectCompactionRange(currentAgent.session, measurement, { target: budget.target, scale });
      if (!range) {
        emit({ action: "no-useful-range", sessionId: currentAgent.session.id, model: target.model,
          pressure: measurement.totalTokens, threshold: budget.threshold });
        return null;
      }
      const key = `${JSON.stringify([settings.summaryModel, settings.summaryMaxTokens, settings.headroom, settings.routes, settings.allowlist, budget.threshold, target.provider, target.model])}:${range.seqs.join(",")}`;
      const rejected = failures.get(currentAgent.session);
      if (rejected?.has(key)) {
        emit({ action: "skip-rejected-range", sessionId: currentAgent.session.id, model: target.model });
        return null;
      }
      try {
        // Exactly one successful commit per step. The next NORMAL request
        // refreshes real usage; do not compact a fresh checkpoint immediately.
        const result = await this.compactRegion(range.start, range.end, currentAgent, signal);
        committedAnchors.set(currentAgent.session, anchor);
        const after = meter.measure(currentAgent.session);
        emit({ action: "compacted", sessionId: currentAgent.session.id, model: target.model,
          pressureBefore: measurement.totalTokens, pressureAfter: after.totalTokens,
          threshold: budget.threshold, target: budget.target, scale,
          selectedNodes: range.seqs.length, expectedReduction: range.removedTokens });
        failures.delete(currentAgent.session);
        return result;
      } catch (error) {
        if (SUMMARY_REJECTED.test(error?.message ?? "") || ["MAX_TOKENS", "SUMMARY_MODEL_UNAVAILABLE", "UNSUPPORTED_SUMMARY_CONTENT", "SUMMARY_CONTEXT_TOO_SMALL"].includes(error?.code)) {
          const keys = rejected ?? new Set();
          keys.add(key);
          if (keys.size > 8) keys.delete(keys.values().next().value);
          failures.set(currentAgent.session, keys);
          emit({ action: error?.code === "MAX_TOKENS" ? "summary-truncated" : "summary-rejected", code: error?.code, sessionId: currentAgent.session.id, model: target.model,
            selectedNodes: range.seqs.length });
        }
        throw error;
      }
    };
    engine.compactIfNeeded = patch.compact;
    engine.summarize = patch.summarize;
    Object.defineProperty(engine, PATCH, { value: patch, configurable: true });
    patches.set(engine, patch);
    agentEngines.set(agent, engine);
    status.engines = patches.size;
    delete status.reason;
  };
  if (typeof ctx.on !== "function") {
    status.state = "unsupported";
    return () => {};
  }
  recovery = installFactoryRequestRecovery(ctx, readConfig, resolveEngine, supported, record);
  const disposers = [
    ctx.on("agent/pre-step", function(payload, next) { attach(payload.agent, this); return next(); }, { prepend: true }),
    ctx.on("agent/status", function({ agent, status: phase }) { if (phase === "running") attach(agent, this, false); }),
    ctx.on("agent/disposed", ({ agent }) => {
      const engine = agentEngines.get(agent);
      const patch = patches.get(engine);
      if (!patch) return;
      patch.agents.delete(agent);
      if (!patch.agents.size) restore(engine, patch);
    }),
  ];
  const dispose = () => {
    recovery.dispose();
    for (const stop of disposers) if (typeof stop === "function") stop();
    for (const [engine, patch] of patches) restore(engine, patch);
    status.state = "disposed";
  };
  if (typeof ctx.effect === "function") ctx.effect(() => dispose, "Factory context optimization");
  return dispose;
}

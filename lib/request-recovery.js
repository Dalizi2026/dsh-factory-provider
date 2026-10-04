// Recovery runs at DSH's durable session boundary, never by silently editing
// a gateway request. Original attachments/events and tool pairs remain owned
// by the host. All work is scoped to the failing Factory session.
import { ROUTES, servableModels } from "./catalog.js";
import { isRequestTooLarge, smallerSummaryInput, requestSizeBreakdown } from "./request-size.js";

const REPLAY = Symbol("factory-request-size-recovery");
const MAX_REQUEST_RECOVERIES = 2;
const MAX_SUMMARY_ATTEMPTS = 3;
const read = (value, fallback) => (typeof value?.get === "function" ? value.get() : value) ?? fallback;

function eligible(session, source) {
  if (read(source?.enabled, true) === false || read(source?.factoryRequestRecovery, true) === false) return false;
  const target = session?.requestHeader?.()?.config;
  const route = Object.keys(ROUTES).find(route => ROUTES[route].key === target?.provider);
  return route && read(source?.routes, Object.keys(ROUTES)).includes(route) && servableModels(route).some(model => model.id === target.model);
}

function retainedImages(session, seqs) {
  const images = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type !== "user/message" && event?.type !== "tool/result") continue;
    const message = session.deriveEventMessage(event);
    let imageIndex = 0;
    for (const block of message?.content ?? []) {
      if (block.type !== "image") continue;
      if (block.offloaded !== true) images.push({ seq, imageIndex });
      imageIndex++;
    }
  }
  return images;
}

/** Use the native, registered image/offload projection. Append validates
 * everything before changing the log; unsupported hosts fail without mutation. */
export function offloadOldImages(session, seqs, sessions, keepLatest = false) {
  if (!sessions?.messageProjections?.some(projection => projection.type === "image/offload") ||
      typeof session?.deriveEventMessage !== "function" || typeof session?.append !== "function") return null;
  const images = retainedImages(session, seqs);
  if (!images.length) return null;
  const candidates = keepLatest ? images.filter(image => image.seq !== images.at(-1).seq) : images;
  if (!candidates.length) return null;
  const count = Math.min(candidates.length, Math.max(1, Math.ceil(images.length / 2)));
  const targets = [];
  for (const image of candidates.slice(0, count)) {
    let target = targets.at(-1);
    if (target?.seq !== image.seq) { target = { seq: image.seq, imageIndexes: [] }; targets.push(target); }
    target.imageIndexes.push(image.imageIndex);
  }
  session.append("image/offload", { targets });
  const remaining = retainedImages(session, seqs).length;
  return remaining < images.length ? { before: images.length, after: remaining, offloaded: images.length - remaining } : null;
}

function operationOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    if (session.eventAt(seq)?.type === "compaction/start") return seq;
  }
  return -1;
}

export function installFactoryRequestRecovery(ctx, readConfig, resolveEngine, supported, record = () => {}) {
  const requests = new WeakMap();
  const summaries = new WeakMap();
  const emit = data => record({ route: "plugin", event: "request-size-recovery", ...data });
  const summaryState = session => {
    const operation = operationOf(session);
    let state = summaries.get(session);
    if (!state || state.operation !== operation) { state = { operation, attempts: 0 }; summaries.set(session, state); }
    return state;
  };
  const disposers = [
    ctx.on("agent/request-error", async function(payload, next) {
      const { agent, failure, signal } = payload;
      if (payload[REPLAY] || !eligible(agent?.session, readConfig()) || !isRequestTooLarge(failure) || signal?.aborted) return next();
      const { engine } = resolveEngine(ctx, agent, this);
      if (!supported(engine, agent)) return next();
      let state = requests.get(agent.session);
      if (!state) { state = { attempts: 0, imageDone: false, compactDone: false }; requests.set(agent.session, state); }
      if (state.attempts >= MAX_REQUEST_RECOVERIES) { emit({ action: "exhausted", sessionId: agent.session.id }); return next(); }
      state.attempts++;
      // Leave newer visual context available. If byte pressure persists, the
      // next recovery is one native, balanced history compaction, not a loop
      // that removes every remaining image from the conversation.
      if (!state.imageDone) {
        state.imageDone = true;
        try {
          const progress = offloadOldImages(agent.session, agent.session.surface.nodes, engine.ctx.get("sessions"), true);
          if (progress && !signal?.aborted) { emit({ action: "images-offloaded", sessionId: agent.session.id, ...progress }); return { kind: "retry" }; }
        } catch (error) { emit({ action: "image-recovery-unavailable", sessionId: agent.session.id }); }
      }
      if (state.compactDone || signal?.aborted || typeof ctx.waterfall !== "function") return next();
      state.compactDone = true;
      // Re-dispatch through the SAME scope carrier and native overflow budget.
      // The original failure is untouched and remains the final error if no
      // durable reduction can be made. REPLAY prevents recursive interception.
      const action = await ctx.waterfall(this, "agent/request-error", {
        ...payload, [REPLAY]: true, failure: { ...failure, code: "CONTEXT_WINDOW_EXCEEDED" },
      }, () => undefined);
      if (action?.kind === "retry" && !signal?.aborted) { emit({ action: "history-compacted", sessionId: agent.session.id }); return action; }
      emit({ action: "no-safe-progress", sessionId: agent.session.id });
      return next();
    }, { prepend: true }),
    // The native summary recovery contract is SYNCHRONOUS. Returning a Promise
    // here would be truthy even when no recovery happened, causing a loop.
    ctx.on("compaction/summary-error", function({ session, sourceEventSeqs, error, signal }, next) {
      if (!eligible(session, readConfig()) || !isRequestTooLarge(error?.failure ?? error) || signal?.aborted || summaryState(session).attempts >= MAX_SUMMARY_ATTEMPTS) return next();
      try {
        const progress = offloadOldImages(session, sourceEventSeqs, ctx.get("sessions"));
        if (progress) { emit({ action: "summary-images-offloaded", sessionId: session.id, ...progress }); return true; }
      } catch { emit({ action: "summary-image-recovery-unavailable", sessionId: session.id }); }
      return next();
    }, { prepend: true }),
    ctx.on("agent/status", ({ agent, status }) => { if (status === "idle") requests.delete(agent.session); }),
    ctx.on("session/event", (session, event) => { if (event.type === "assistant/message") requests.delete(session); }),
  ];
  return {
    async summarize(input, agent, signal, send) {
      if (!eligible(agent.session, readConfig())) return send(input);
      const state = summaryState(agent.session);
      let current = input;
      while (state.attempts < MAX_SUMMARY_ATTEMPTS) {
        signal?.throwIfAborted();
        state.attempts++;
        try { return await send(current); }
        catch (error) {
          state.error = error;
          if (!isRequestTooLarge(error?.failure ?? error) || signal?.aborted) throw error;
          // Give the synchronous native seam the first chance to offload
          // summary images; text reduction is useful once those are gone.
          if ((current.messages ?? []).some(message => message.content?.some?.(block => block.type === "image" && !block.offloaded)) &&
              ctx.get("sessions")?.messageProjections?.some(projection => projection.type === "image/offload")) throw error;
          const smaller = smallerSummaryInput(current);
          if (!smaller || state.attempts >= MAX_SUMMARY_ATTEMPTS) throw error;
          emit({ action: "summary-text-bounded", sessionId: agent.session.id, attempt: state.attempts,
            beforeBytes: requestSizeBreakdown(current).bodyBytes, afterBytes: requestSizeBreakdown(smaller).bodyBytes });
          current = smaller;
        }
      }
      throw state.error ?? new Error("Factory request-size recovery exhausted its summary attempt budget");
    },
    dispose() { for (const stop of disposers) if (typeof stop === "function") stop(); },
  };
}

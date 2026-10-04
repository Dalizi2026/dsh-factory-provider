// Per-call image preparation around the verified PiAiAdapter seam. No global
// provider/profile or attachment mutation; originals and SDK conversion stay
// owned by DSH. Final wire bytes are still checked by the loopback gateway.
import { ROUTES, servableModels } from './catalog.js';
import { DEFAULT_REQUEST_MAX_BYTES, FACTORY_IMAGE_MAX_BYTES } from './request-size.js';
import { scopeFactoryRequest } from './request-purpose.js';
const PATCH = Symbol.for('dsh-factory-provider.adaptive-images');
const BASE_BYTES = 200 * 1024;
const MIN_BYTES = 32 * 1024;
const MAX_EDGE = 1024;
const RESERVE = 64 * 1024;
const read = (v, fallback) => (typeof v?.get === 'function' ? v.get() : v) ?? fallback;
const base64Bytes = n => 4 * Math.ceil(n / 3);

export function collectRequestImages(options) {
  const occurrences = [], refs = new Map();
  let latestMessage = -1;
  for (const [mi, message] of (options.messages ?? []).entries()) {
    if (message.role === 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block.type !== 'image' || block.offloaded === true) continue;
      if (!block.attachment?.attachmentId) throw new Error('Factory adaptive images require durable attachment references');
      refs.set(block.attachment.attachmentId, block.attachment);
      occurrences.push({ id: block.attachment.attachmentId, message: mi });
      latestMessage = mi;
    }
  }
  return { refs, occurrences, latestMessage };
}

function nonImageEstimate(options, count) {
  // This is a conservative estimate, NOT final wire serialization. Use only
  // fields that can reach the SDK; attachment handles and provider envelopes
  // need additional room. The gateway remains the exact last check.
  let representedImages = 0;
  const messages = (options.messages ?? []).map(message => ({
    role: message.role,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    content: (message.content ?? []).filter(block => {
      if (block.type === 'image') { representedImages++; return false; }
      return true;
    }),
  }));
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools: options.tools, system: options.system })) * 1.2) + RESERVE + Math.max(count, representedImages) * 1024;
}

export function imageBudgetPlan(options, profile = {}, config = {}) {
  const images = collectRequestImages(options), count = images.occurrences.length;
  const bodyLimit = read(config.factoryRequestMaxBytes, DEFAULT_REQUEST_MAX_BYTES);
  const imageLimit = Math.min(FACTORY_IMAGE_MAX_BYTES, profile.maxRequestImageBytes ?? FACTORY_IMAGE_MAX_BYTES);
  const estimatedOtherBytes = nonImageEstimate(options, count);
  const available = bodyLimit > 0 ? Math.max(0, bodyLimit - estimatedOtherBytes) : imageLimit;
  const budget = Math.min(imageLimit, available);
  // Rounded buckets keep targets identical across nearby turns, avoiding
  // needless re-encoding of the same historical attachment.
  const fair = count ? Math.floor(budget / count / 4) * 3 : BASE_BYTES;
  const singleLimit = Math.min(BASE_BYTES, profile.requestImageMaxBytes ?? BASE_BYTES);
  const maxBytes = [200, 100, 50, 32].map(kib => kib * 1024).find(bytes => bytes <= fair && bytes <= singleLimit)
    ?? Math.min(MIN_BYTES, singleLimit);
  return { ...images, count, budget, imageLimit, estimatedOtherBytes, maxBytes,
    maxEdge: Math.min(MAX_EDGE, Math.max(512, Math.floor(MAX_EDGE * Math.sqrt(maxBytes / BASE_BYTES)))),
    maxPixels: Math.min(profile.requestImagePixelBudget ?? 4194304, MAX_EDGE * MAX_EDGE) };
}

function targetOf(ref, plan, attempt) {
  const scale = Math.min(1, plan.maxEdge / Math.max(ref.width, ref.height), Math.sqrt(plan.maxPixels / (ref.width * ref.height))) * (0.7 ** attempt);
  return { width: Math.max(1, Math.round(ref.width * scale)), height: Math.max(1, Math.round(ref.height * scale)), maxBytes: plan.maxBytes };
}
function failure(code, message, extra = {}) { return { type: 'finish', reason: { kind: 'error', failure: { code, message, ...extra } } }; }

export async function prepareAdaptiveImages(options, profile, store, config = {}, record = () => {}) {
  const plan = imageBudgetPlan(options, profile, config), versions = new Map();
  if (!plan.count) return { plan, versions };
  const entries = [...plan.refs], results = new Array(entries.length);
  let cursor = 0, error;
  // Bound concurrent encoders independently of number of images. Native store
  // also has a codec semaphore; repeated references are prepared only once.
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (!error) {
      const index = cursor++; if (index >= entries.length) break;
      const [id, ref] = entries[index];
      try {
        let smallest;
        for (let attempt = 0; attempt < 3; attempt++) {
          options.signal?.throwIfAborted();
          const version = await store.readImageRequest(ref, targetOf(ref, plan, attempt), options.signal);
          const actualBytes = version.data.byteLength;
          if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0) throw new Error('Invalid image request version bytes');
          const measured = { ...version, bytes: actualBytes };
          if (!smallest || actualBytes < smallest.bytes) smallest = measured;
          if (actualBytes <= plan.maxBytes) break;
        }
        results[index] = [id, smallest];
      } catch (caught) { error ??= caught; }
    }
  });
  await Promise.all(workers);
  options.signal?.throwIfAborted();
  if (error) throw error;
  for (const [id, version] of results) versions.set(id, version);
  const sizeOf = occurrence => base64Bytes(versions.get(occurrence.id).bytes);
  const total = plan.occurrences.reduce((n, image) => n + sizeOf(image), 0);
  record({ route: 'plugin', event: 'adaptive-images', model: options.model, purpose: options.purpose,
    images: plan.count, uniqueImages: versions.size, estimatedOtherBytes: plan.estimatedOtherBytes,
    imageBudgetBytes: plan.budget, targetBytesPerImage: plan.maxBytes, imageBase64Bytes: total, maxEdge: plan.maxEdge });
  if (total > plan.budget) {
    const fresh = plan.occurrences.filter(image => image.message === plan.latestMessage);
    const freshBytes = fresh.reduce((n, image) => n + sizeOf(image), 0);
    if (freshBytes > plan.imageLimit) return { plan, versions, failure: failure('MULTI_IMAGE_BUDGET_EXCEEDED',
      `Factory: this batch of ${fresh.length} new images still exceeds the image budget after compression. Send a smaller batch or request fewer images together; this batch was not silently dropped.`) };
    if (freshBytes > plan.budget) return { plan, versions, failure: failure('INVALID_REQUEST',
      '413 Request Entity Too Large: text/tools leave insufficient space for the new images; history recovery is required.', { status: 413 }) };
    let remaining = total, offloadImages = 0;
    for (const image of plan.occurrences) {
      if (image.message === plan.latestMessage || remaining <= plan.budget) break;
      remaining -= sizeOf(image); offloadImages++;
    }
    if (offloadImages) return { plan, versions, failure: failure('IMAGE_OFFLOAD_REQUIRED',
      `Factory: compressed images need ${offloadImages} older occurrence(s) offloaded; new batch retained.`, { offloadImages }) };
  }
  return { plan, versions };
}

function eligible(options, config) {
  if (read(config.enabled, true) === false) return false;
  const route = Object.keys(ROUTES).find(route => ROUTES[route].key === options.provider);
  return route && read(config.routes, Object.keys(ROUTES)).includes(route) && servableModels(route).some(model => model.id === options.model);
}
function supported(adapter) {
  return adapter?.constructor?.name === 'PiAiAdapter' && typeof adapter.streamWithSnapshot === 'function' &&
    typeof adapter.profileOf === 'function' && typeof adapter.modelOf === 'function' && typeof adapter.config?.resolveAttachments === 'function';
}
export function installAdaptiveImages(ctx, readConfig, status = {}, record = () => {}) {
  const patches = new Map(), owner = {};
  let disposed = false;
  status.state = 'waiting';
  const restore = (adapter, patch) => {
    if (adapter.streamWithSnapshot === patch.wrapped) {
      if (patch.own) adapter.streamWithSnapshot = patch.original;
      else delete adapter.streamWithSnapshot;
    }
    if (adapter[PATCH]?.owner === owner) delete adapter[PATCH];
    patches.delete(adapter);
  };
  const attach = llm => {
    if (disposed) return;
    if (typeof llm?.registration !== 'function') { status.state = 'unsupported'; return; }
    const active = new Set();
    const providers = {};
    for (const { key } of Object.values(ROUTES)) {
      let adapter; try { adapter = llm.registration(key).adapter; } catch { providers[key] = 'waiting'; continue; }
      if (!supported(adapter)) { providers[key] = 'unsupported'; continue; }
      providers[key] = 'active';
      active.add(adapter);
      if (adapter[PATCH]) continue;
      const original = adapter.streamWithSnapshot, own = Object.hasOwn(adapter, 'streamWithSnapshot');
      const wrapped = async function*(options, snapshot) {
        const config = readConfig();
        if (disposed || !eligible(options, config)) {
          yield* original.call(this, options, snapshot); return;
        }
        // Purpose metadata is independent of image compression: text-only
        // summaries and summaries with the image toggle off also need it.
        const callSnapshot = scopeFactoryRequest(snapshot, options);
        if (read(config.factoryAdaptiveImages, true) === false || !collectRequestImages(options).occurrences.length ||
            options.messages.some(message => !['user', 'tool'].includes(message.role) && message.content?.some(block => block.type === 'image')) ||
            !this.modelOf(callSnapshot, options.provider, options.model).input.includes('image')) {
          yield* original.call(this, options, callSnapshot); return;
        }
        options.signal?.throwIfAborted();
        const store = this.config.resolveAttachments();
        if (typeof store?.readImageRequest !== 'function') { status.state = 'unsupported'; yield* original.call(this, options, callSnapshot); return; }
        const profile = callSnapshot.profiles.get(options.provider);
        const prepared = await prepareAdaptiveImages(options, profile, store, config, record);
        if (prepared.failure) { yield prepared.failure; return; }
        // Request-local facade and immutable profile copy preserve prepared
        // generation/model identity, other sessions, and other providers.
        const scopedStore = new Proxy(store, { get(target, key) {
          if (key === 'readImageRequest') return (ref, _target, signal) => {
            signal?.throwIfAborted();
            const version = prepared.versions.get(ref.attachmentId);
            if (!version) throw new Error('Factory adaptive image version is unavailable');
            return Promise.resolve(version);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const facade = Object.create(this);
        Object.defineProperty(facade, 'config', { value: { ...this.config, resolveAttachments: () => scopedStore } });
        const profiles = new Map(callSnapshot.profiles);
        profiles.set(options.provider, { ...profile, maxRequestImageBytes: prepared.plan.budget });
        status.state = 'active';
        yield* original.call(facade, options, { ...callSnapshot, profiles });
      };
      const patch = { owner, original, wrapped, own };
      adapter.streamWithSnapshot = wrapped;
      Object.defineProperty(adapter, PATCH, { value: patch, configurable: true });
      patches.set(adapter, patch); status.state = 'active';
    }
    for (const [adapter, patch] of patches) if (!active.has(adapter)) restore(adapter, patch);
    status.adapters = patches.size;
    status.providers = providers;
    status.state = Object.values(providers).includes('unsupported') ? 'unsupported' : patches.size ? 'active' : 'waiting';
  };
  if (typeof ctx.inject !== 'function') { status.state = 'unsupported'; return () => {}; }
  const stop = ctx.inject(['llm'], child => {
    attach(child.llm);
    child.on?.('llm/adapters-updated', () => attach(child.llm));
  });
  const dispose = () => { disposed = true; if (typeof stop === 'function') stop(); for (const [adapter, patch] of patches) restore(adapter, patch); status.state = 'disposed'; };
  ctx.effect?.(() => dispose, 'Factory adaptive image preparation');
  return dispose;
}

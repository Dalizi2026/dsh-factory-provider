import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
// Cache markers are rebuilt by the gateway and are not conversation edits.
const json = value => JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function describe(body) {
  if (!Array.isArray(body.messages)) return undefined;
  const calls = new Map(), results = [], seen = new Set();
  for (const message of body.messages) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') {
        if (typeof block.id !== 'string' || calls.has(block.id)) return undefined;
        calls.set(block.id, block);
      } else if (block?.type === 'tool_result') {
        if (!calls.has(block.tool_use_id) || seen.has(block.tool_use_id)) return undefined;
        seen.add(block.tool_use_id);
        results.push({ id: block.tool_use_id, bytes: Buffer.byteLength(json(block)) });
      }
    }
  }
  // Do not infer server pair counts from an incomplete tool round.
  if (results.length !== calls.size) return undefined;
  return { results, prefix: body.messages.map(message => hash(json(message))),
    bytes: Buffer.byteLength(json(body.messages)),
    header: hash(json({ model: body.model, system: body.system, tools: body.tools,
      thinking: body.thinking, output: body.output_config, choice: body.tool_choice, speed: body.speed })) };
}

/** Keep the server's last confirmed clearing boundary between batches.
 * No text/IDs are stored, no conversation history is edited, and no request is
 * retried. Account, native session and exact outgoing prefix must all match.
 * Estimates decide when to release a boundary, never replace token accounting.
 */
export function createToolClearBatches({ maxEntries = 128, ttlMs = 300000, now = Date.now } = {}) {
  const states = new Map();
  return {
    plan(body, { session, account, keep, trigger, batchTokens, maxInputTokens, cacheTtlMs = ttlMs }) {
      if (!/^[a-f0-9]{64}$/.test(session ?? '') || !account || batchTokens <= 0) return undefined;
      const shape = describe(body);
      if (!shape || !shape.results.length || !finite(maxInputTokens) || maxInputTokens === 0) return undefined;
      const key = hash(json([session, account, body.model, keep, trigger, batchTokens]));
      const expected = states.get(key);
      const valid = expected && now() - expected.updatedAt < cacheTtlMs && expected.header === shape.header &&
        expected.prefix.length <= shape.prefix.length && expected.prefix.every((digest, index) => digest === shape.prefix[index]);
      const previous = valid ? expected : undefined;
      const eligibleBytes = shape.results.slice(0, Math.max(0, shape.results.length - keep)).reduce((sum, result) => sum + result.bytes, 0);
      const addedEligibleTokens = previous ? Math.ceil(Math.max(0, eligibleBytes - previous.anchorEligibleBytes) / 4) : 0;
      const estimatedActive = previous ? previous.anchorPrompt + Math.ceil(Math.max(0, shape.bytes - previous.anchorBytes) / 3) : 0;
      const ceiling = previous ? Math.min(Math.floor(maxInputTokens * 0.8), Math.max(trigger, previous.anchorPrompt) + batchTokens) : 0;
      const pinnedKeep = previous ? shape.results.length - previous.cleared : keep;
      const pin = previous && pinnedKeep >= keep && addedEligibleTokens < batchTokens && estimatedActive < ceiling;
      return { key, expected, shape, eligibleBytes, mode: pin ? 'pinned' : 'batch',
        keep: pin ? pinnedKeep : keep, minimum: batchTokens,
        addedEligibleTokens, estimatedActive };
    },
    commit(plan, usage) {
      if (!plan || states.get(plan.key) !== plan.expected) return;
      const cleared = usage?.clearedToolUses;
      const prompt = (usage?.input ?? 0) + (usage?.read ?? 0) + (usage?.write ?? 0);
      if (!Number.isInteger(cleared) || cleared <= 0 || cleared > plan.shape.results.length ||
          !finite(prompt) || prompt <= 0) { states.delete(plan.key); return; }
      const previous = plan.expected;
      // If the backend moved the boundary despite pinning, do not pin again
      // on an assumption that the editing strategy honoured the requested keep.
      if (plan.mode === 'pinned' && cleared !== previous?.cleared) { states.delete(plan.key); return; }
      const anchor = plan.mode === 'pinned' ? previous : {
        anchorPrompt: prompt, anchorBytes: plan.shape.bytes, anchorEligibleBytes: plan.eligibleBytes };
      states.delete(plan.key);
      states.set(plan.key, { ...anchor, cleared, header: plan.shape.header,
        prefix: plan.shape.prefix, updatedAt: now() });
      if (states.size > maxEntries) states.delete(states.keys().next().value);
    },
    clear() { states.clear(); },
    size() { return states.size; },
  };
}

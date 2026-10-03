// Anthropic prompt-cache breakpoints.
//
// Measured behaviour of this route (claude-haiku, append-only conversation):
//   client-style marker on the last message only  → 99% hit from turn 2
//   proxy-style marker on system + last message   → 100% hit, fewer writes
// So breakpoint placement is not what costs hits; unstable prefix bytes are.
// This module therefore only ever moves markers onto stable positions, and the
// caller pairs it with a prefix fingerprint so instability is visible.
//
// Anthropic rules encoded here:
//   - at most 4 blocks carrying cache_control per request;
//   - a longer TTL must not follow a shorter one (tools → system → messages);
//   - the cached prefix is tools → system → messages, so a marker caches
//     everything before it on that path.

const MAX_BREAKPOINTS = 4;
const MODES = new Set(["passthrough", "auto", "rewrite"]);

/** Block types that may carry a breakpoint. thinking/redacted_thinking are
 *  rejected by the edge, and an empty text block is not worth a slot. */
function isCacheableBlock(block) {
  if (block === null || typeof block !== "object") return false;
  if (block.type !== "text") return false;
  return typeof block.text === "string" && block.text.length > 0;
}

function hasMarker(block) {
  return block !== null && typeof block === "object" && block.cache_control !== undefined;
}

/** Every place a client may legitimately have put a marker. Deliberately NOT a
 *  recursive search: tool inputs, JSON schemas and user data may contain a
 *  field called cache_control that has nothing to do with caching. */
function collectClientMarkers(parsed) {
  const found = [];
  if (parsed.cache_control !== undefined) found.push({ where: "top", ttl: parsed.cache_control?.ttl });

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  for (const tool of tools) {
    if (hasMarker(tool)) found.push({ where: "tools", ttl: tool.cache_control?.ttl });
  }

  const system = Array.isArray(parsed.system) ? parsed.system : [];
  for (const block of system) {
    if (hasMarker(block)) found.push({ where: "system", ttl: block.cache_control?.ttl });
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (hasMarker(block)) found.push({ where: "messages", ttl: block.cache_control?.ttl });
    }
  }
  return found;
}

/** Remove markers from the known surfaces only. Returns how many were removed. */
function stripClientMarkers(parsed) {
  let removed = 0;
  if (parsed.cache_control !== undefined) {
    delete parsed.cache_control;
    removed += 1;
  }
  const strip = (holder) => {
    if (!hasMarker(holder)) return;
    delete holder.cache_control;
    removed += 1;
  };
  for (const tool of Array.isArray(parsed.tools) ? parsed.tools : []) strip(tool);
  for (const block of Array.isArray(parsed.system) ? parsed.system : []) strip(block);
  for (const message of Array.isArray(parsed.messages) ? parsed.messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) strip(block);
  }
  return removed;
}

/** A string content is upgraded to a single text block so a marker has
 *  somewhere legal to live. The text itself is never altered. */
function asBlocks(content) {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : undefined;
  }
  return Array.isArray(content) ? content : undefined;
}

/** Mark the last cacheable block of `holder.content`, upgrading a string. */
function markContent(holder, marker) {
  if (holder === null || typeof holder !== "object") return false;
  if (typeof holder.content === "string") {
    if (holder.content.length === 0) return false;
    holder.content = [{ type: "text", text: holder.content, cache_control: marker }];
    return true;
  }
  if (!Array.isArray(holder.content)) return false;
  for (let i = holder.content.length - 1; i >= 0; i -= 1) {
    if (isCacheableBlock(holder.content[i])) {
      holder.content[i].cache_control = marker;
      return true;
    }
  }
  return false;
}

/**
 * Place breakpoints on stable positions. Never touches message text, thinking
 * blocks, tool_use/tool_result ids or arguments — only the marker field.
 *
 * @returns {{changed: boolean, source: string, breakpoints: number,
 *            ttlSummary: Record<string, number>, warnings: string[]}}
 */
export function applyAnthropicCacheBreakpoints(parsed, { mode = "auto", ttl = "5m" } = {}) {
  const report = { changed: false, source: "none", breakpoints: 0, ttlSummary: {}, warnings: [] };
  if (parsed === null || typeof parsed !== "object") return report;
  if (!MODES.has(mode)) {
    report.warnings.push(`unknown cache mode "${mode}", leaving the request untouched`);
    return report;
  }

  const clientMarkers = collectClientMarkers(parsed);
  if (mode === "passthrough") {
    report.source = clientMarkers.length > 0 ? "client" : "none";
    report.breakpoints = clientMarkers.length;
    for (const m of clientMarkers) report.ttlSummary[m.ttl ?? "(default)"] = (report.ttlSummary[m.ttl ?? "(default)"] ?? 0) + 1;
    return report;
  }

  // auto: a client that already manages caching is left alone. Injecting next
  // to it risks exceeding the 4-block cap and fighting its strategy.
  if (mode === "auto" && clientMarkers.length > 0) {
    report.source = "client";
    report.breakpoints = clientMarkers.length;
    for (const m of clientMarkers) report.ttlSummary[m.ttl ?? "(default)"] = (report.ttlSummary[m.ttl ?? "(default)"] ?? 0) + 1;
    if (clientMarkers.length > MAX_BREAKPOINTS) {
      report.warnings.push(`${clientMarkers.length} client breakpoints exceeds the ${MAX_BREAKPOINTS} limit`);
    }
    return report;
  }

  if (mode === "rewrite" && clientMarkers.length > 0) {
    stripClientMarkers(parsed);
    report.changed = true;
  }

  const marker = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  let placed = 0;

  // 1. the last tool definition — a stable prefix of its own.
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  for (let i = tools.length - 1; i >= 0 && placed < MAX_BREAKPOINTS; i -= 1) {
    if (tools[i] !== null && typeof tools[i] === "object" && !hasMarker(tools[i])) {
      tools[i].cache_control = marker;
      placed += 1;
      break;
    }
  }

  // 2. the last real system block.
  if (Array.isArray(parsed.system)) {
    for (let i = parsed.system.length - 1; i >= 0 && placed < MAX_BREAKPOINTS; i -= 1) {
      if (isCacheableBlock(parsed.system[i]) && !hasMarker(parsed.system[i])) {
        parsed.system[i].cache_control = marker;
        placed += 1;
        break;
      }
    }
  } else if (typeof parsed.system === "string" && parsed.system.length > 0) {
    parsed.system = [{ type: "text", text: parsed.system, cache_control: marker }];
    placed += 1;
  }

  // 3. the newest message: next turn it is history, and this is what makes the
  //    whole prefix reusable rather than just the static head.
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (let i = messages.length - 1; i >= 0 && placed < MAX_BREAKPOINTS; i -= 1) {
    if (markContent(messages[i], marker)) {
      placed += 1;
      break;
    }
  }

  report.breakpoints = placed;
  report.source = placed > 0 ? "proxy" : "none";
  report.ttlSummary[ttl] = placed;
  report.changed = report.changed || placed > 0;
  if (placed > MAX_BREAKPOINTS) report.warnings.push(`placed ${placed} breakpoints, over the limit`);
  return report;
}

/** Short, content-free fingerprints so two turns can be diffed without logging
 *  any text. `prefix` is the rolling hash: the first index that differs between
 *  two turns is exactly where the request stopped being append-only. */
export function fingerprintAnthropicPayload(parsed, hash) {
  const h = (value) => hash(JSON.stringify(value) ?? "").slice(0, 12);
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  let rolling = hash("");
  const prefixes = [];
  for (const message of messages) {
    rolling = hash(`${rolling}\u0000${JSON.stringify(message)}`);
    prefixes.push(rolling.slice(0, 12));
  }
  return {
    system: h(parsed.system ?? null),
    tools: h(parsed.tools ?? null),
    toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    messages: prefixes,
  };
}

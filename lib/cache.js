// Anthropic prompt-cache breakpoints.
//
// What was measured, and what it does not prove:
//
//   With a strictly append-only conversation on claude-haiku, a client-style
//   marker on the last message alone already reached 99% from turn 2, and a
//   proxy-style placement on system + last message reached 100%. That second
//   comparison is confounded — the proxy run read the cache the client run had
//   just written, so it was never cold — and neither run says anything about a
//   real DSH session.
//
//   So the honest statement is: in synthetic append-only traffic, both
//   placements hit. Why a real session reports ~60% is NOT established. Prefix
//   instability is one candidate; TTL expiry between turns, breakpoint coverage
//   at the tail, changed request options and the way the ratio is computed are
//   others. That is what the fingerprint, the request id and the usage records
//   exist to settle.
//
// This module therefore does the part that is safe without knowing the cause —
// it moves markers onto stable positions — and leaves the diagnosis to the
// records the caller writes.
//
// Anthropic rules encoded here:
//   - at most 4 blocks carrying cache_control per request;
//   - a longer TTL must not follow a shorter one (tools → system → messages);
//   - the cached prefix is tools → system → messages, so a marker caches
//     everything before it on that path.

const MAX_BREAKPOINTS = 4;
const MODES = new Set(["passthrough", "auto", "rewrite"]);

/** Block types that may carry a breakpoint.
 *
 *  text         — the ordinary case.
 *  tool_result  — verified against the live edge: a marker here is accepted and
 *                 caches the prefix through the tool output. Without it a
 *                 tool-heavy turn falls back to an earlier text block and pays a
 *                 cache write for everything after it on every turn.
 *
 *  thinking and redacted_thinking are not markable, an empty text block is not
 *  worth a slot, and image / document have not been verified against this edge,
 *  so they are left alone rather than assumed to behave like the spec. */
function isCacheableBlock(block) {
  if (block === null || typeof block !== "object") return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
  if (block.type === "tool_result") return true;
  return false;
}

function hasMarker(block) {
  return block !== null && typeof block === "object" && block.cache_control !== undefined;
}

const TTL_ORDER = { "5m": 5, "1h": 60 };
const DEFAULT_TTL = "5m";

/** Read-only check of markers the client sent. Anthropic requires that a longer
 *  TTL never follows a shorter one along the cache path (tools → system →
 *  messages), and this route accepts at most 4 marked blocks. Nothing here
 *  changes the request: auto and passthrough keep the client's strategy even
 *  when it is illegal, and the warning says so. */
export function validateClientMarkers(markers) {
  const warnings = [];
  if (markers.length === 0) return warnings;
  if (markers.length > MAX_BREAKPOINTS) {
    warnings.push(`${markers.length} client breakpoints exceeds the ${MAX_BREAKPOINTS}-block limit`);
  }
  const rank = { tools: 0, system: 1, messages: 2 };
  const ordered = [...markers].sort((a, b) => rank[a.where] - rank[b.where]);
  let seenShort = undefined;
  for (const marker of ordered) {
    const ttl = typeof marker.ttl === "string" && TTL_ORDER[marker.ttl] !== undefined ? marker.ttl : DEFAULT_TTL;
    if (typeof marker.ttl === "string" && TTL_ORDER[marker.ttl] === undefined) {
      warnings.push(`unknown ttl "${marker.ttl}" on a ${marker.where} marker`);
    }
    if (seenShort !== undefined && TTL_ORDER[ttl] > TTL_ORDER[seenShort]) {
      warnings.push(
        `ttl order is illegal: a ${ttl} marker on ${marker.where} follows a ${seenShort} marker (longer must come first)`,
      );
    }
    if (seenShort === undefined || TTL_ORDER[ttl] < TTL_ORDER[seenShort]) seenShort = ttl;
  }
  return warnings;
}

/** Every place a client may legitimately have put a marker. Deliberately NOT a
 *  recursive search: tool inputs, JSON schemas and user data may contain a
 *  field called cache_control that has nothing to do with caching. */
function collectClientMarkers(parsed) {
  const found = [];
  const add = (where, index, ttl) => found.push({ where, index, ttl });
  if (parsed.cache_control !== undefined) add("top", 0, parsed.cache_control?.ttl);

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  for (const [i, tool] of tools.entries()) {
    if (hasMarker(tool)) add("tools", i, tool.cache_control?.ttl);
  }

  const system = Array.isArray(parsed.system) ? parsed.system : [];
  for (const [i, block] of system.entries()) {
    if (hasMarker(block)) add("system", i, block.cache_control?.ttl);
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const [i, message] of messages.entries()) {
    if (!Array.isArray(message?.content)) continue;
    for (const [j, block] of message.content.entries()) {
      if (hasMarker(block)) add("messages", i, block.cache_control?.ttl);
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
  const report = {
    changed: false,
    source: "none",
    breakpoints: 0,
    ttlSummary: {},
    markers: [],
    warnings: [],
    // Where the message breakpoint actually landed, and whether the tail had to
    // be skipped. A tool-heavy turn ends in tool_use/tool_result blocks, which
    // this version deliberately does not mark, so the breakpoint falls back to
    // an earlier text block — the newest tool history is then not covered, and
    // that has to be visible rather than silent.
    selectedMessageIndex: null,
    selectedBlockType: null,
    tailExcludedBlocks: 0,
    fallbackToEarlierMessage: false,
  };
  if (parsed === null || typeof parsed !== "object") return report;
  if (!MODES.has(mode)) {
    report.warnings.push(`unknown cache mode "${mode}", leaving the request untouched`);
    return report;
  }

  const clientMarkers = collectClientMarkers(parsed);
  if (mode === "passthrough") {
    report.source = clientMarkers.length > 0 ? "client" : "none";
    report.breakpoints = clientMarkers.length;
    report.markers = clientMarkers;
    report.warnings.push(...validateClientMarkers(clientMarkers));
    for (const m of clientMarkers) report.ttlSummary[m.ttl ?? "(default)"] = (report.ttlSummary[m.ttl ?? "(default)"] ?? 0) + 1;
    return report;
  }

  // auto: a client that already manages caching is left alone. Injecting next
  // to it risks exceeding the 4-block cap and fighting its strategy.
  if (mode === "auto" && clientMarkers.length > 0) {
    report.source = "client";
    report.breakpoints = clientMarkers.length;
    report.markers = clientMarkers;
    // Kept as-is even when illegal: the client owns this strategy in auto mode,
    // and the warning is for the operator, not a licence to rewrite silently.
    report.warnings.push(...validateClientMarkers(clientMarkers));
    for (const m of clientMarkers) report.ttlSummary[m.ttl ?? "(default)"] = (report.ttlSummary[m.ttl ?? "(default)"] ?? 0) + 1;
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

  // 3. The newest message with a markable block, walking backwards so a turn
  //    whose tail is not markable still gets a breakpoint somewhere. The fallback
  //    is recorded, because it means the newest content is not covered.
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const lastContent = messages.at(-1)?.content;
  if (Array.isArray(lastContent)) {
    report.tailExcludedBlocks = lastContent.filter((block) => !isCacheableBlock(block)).length;
  }
  for (let i = messages.length - 1; i >= 0 && placed < MAX_BREAKPOINTS; i -= 1) {
    const content = Array.isArray(messages[i]?.content) ? messages[i].content : undefined;
    if (content !== undefined) {
      const target = content.map((block, index) => ({ block, index })).filter(({ block }) => isCacheableBlock(block)).at(-1);
      if (target !== undefined) {
        target.block.cache_control = marker;
        placed += 1;
        report.selectedMessageIndex = i;
        report.selectedBlockType = target.block.type;
        report.fallbackToEarlierMessage = i < messages.length - 1;
        break;
      }
    }
    if (typeof messages[i]?.content === "string" && messages[i].content.length > 0) {
      messages[i].content = [{ type: "text", text: messages[i].content, cache_control: marker }];
      placed += 1;
      report.selectedMessageIndex = i;
      report.selectedBlockType = "text";
      report.fallbackToEarlierMessage = i < messages.length - 1;
      break;
    }
  }

  report.breakpoints = placed;
  report.markers = [
    ...(tools.at(-1)?.cache_control !== undefined ? [{ where: "tools", index: tools.length - 1, ttl }] : []),
    ...(Array.isArray(parsed.system)
      ? parsed.system.flatMap((block, index) =>
          hasMarker(block) ? [{ where: "system", index, ttl: block.cache_control?.ttl ?? ttl }] : [],
        )
      : []),
    ...(report.selectedMessageIndex !== null
      ? [{ where: "messages", index: report.selectedMessageIndex, ttl }]
      : []),
  ];
  report.source = placed > 0 ? "proxy" : "none";
  report.ttlSummary[ttl] = placed;
  report.changed = report.changed || placed > 0;
  if (placed > MAX_BREAKPOINTS) report.warnings.push(`placed ${placed} breakpoints, over the limit`);
  return report;
}

/** A deep copy with cache markers removed from the known surfaces only.
 *  Never a recursive strip: tool inputs, JSON schemas and tool results may
 *  legitimately carry a field of that name, and dropping those would hide real
 *  content changes from the fingerprint. */
function contentSnapshot(parsed) {
  if (parsed === null || typeof parsed !== "object") return parsed;
  const copy = structuredClone(parsed);
  stripClientMarkers(copy);
  return copy;
}

/** Deterministic JSON: object keys sorted, array order preserved, strings
 *  untouched. Two payloads that differ only in key insertion order produce the
 *  same structural digest, which is what separates "the bytes were reordered"
 *  from "the content changed". */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

/** Content-free fingerprints for diagnosing prefix stability. Both digests
 *  cover the same payload with markers removed from the known surfaces:
 *
 *    raw         — the bytes as they were assembled (key order included)
 *    structural  — object keys sorted, array order and text untouched
 *
 *  raw differs while structural matches means only serialization order changed.
 *  Both differ means real content changed; the first differing message index is
 *  where the request stopped being append-only.
 *
 *  Neither digest is the upstream cache key. Matching digests mean this plugin
 *  observed no change, not that the edge will hit. */
export function fingerprintAnthropicPayload(parsed, hash) {
  const snapshot = contentSnapshot(parsed);
  const short = (value) => hash(value).slice(0, 16);
  const rawOf = (value) => short(JSON.stringify(value) ?? "");
  const structuralOf = (value) => short(JSON.stringify(canonical(value)) ?? "");

  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  let rawRolling = hash("");
  let structuralRolling = hash("");
  const raw = [];
  const structural = [];
  for (const message of messages) {
    rawRolling = hash(`${rawRolling}\u0000${JSON.stringify(message) ?? ""}`);
    structuralRolling = hash(`${structuralRolling}\u0000${JSON.stringify(canonical(message)) ?? ""}`);
    raw.push(rawRolling.slice(0, 16));
    structural.push(structuralRolling.slice(0, 16));
  }

  return {
    system: { raw: rawOf(snapshot?.system ?? null), structural: structuralOf(snapshot?.system ?? null) },
    tools: { raw: rawOf(snapshot?.tools ?? null), structural: structuralOf(snapshot?.tools ?? null) },
    toolCount: Array.isArray(snapshot?.tools) ? snapshot.tools.length : 0,
    messages: { raw, structural },
  };
}

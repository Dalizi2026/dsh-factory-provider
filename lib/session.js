// Session-affinity ids for the gateway.
//
// The official droid CLI carries one x-session-id per session (registered via
// cloud-sync); forwarding with a FRESH random id per request destroys whatever
// session affinity — and with it prompt-cache locality — Factory's edge keys
// on. This module derives a stable id per conversation: the tuple
// (account org, model, system prompt, first user message) hashes to a fixed
// UUID kept in a small LRU, so every turn of one session presents the same id
// while different sessions get different ones.
//
// The guarantee is stability *while the id stays resident*, which is what cache
// affinity needs during a conversation. An id that is evicted (more than the LRU
// holds distinct sessions) or a host restart mints a fresh one, so a conversation
// revisited after eviction starts a new affinity group. That is a deliberate
// trade: deriving the id deterministically instead would make it survive both,
// but would also merge two different accounts that send identical text, and
// Factory keys its cache on the account. Ids are a performance hint either way,
// never correctness state.

import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_ENTRIES = 500;

/** Text of an Anthropic/OpenAI content field (string or block array). */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && typeof block.text === "string") return block.text;
      return "";
    })
    .join("\n");
}

/** The conversation-identifying parts of one request body, per route shape. */
export function sessionKeyParts(route, parsed) {
  if (parsed === null || typeof parsed !== "object") return { system: "", firstUser: "" };
  if (route === "openai") {
    const input = Array.isArray(parsed.input) ? parsed.input : [];
    const system = [
      typeof parsed.instructions === "string" ? parsed.instructions : "",
      ...input
        .filter((item) => item && (item.role === "system" || item.role === "developer"))
        .map((item) => contentText(item.content)),
    ].join("\n");
    return { system, firstUser: firstUserText(input) };
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (route === "anthropic") {
    const system = typeof parsed.system === "string"
      ? parsed.system
      : Array.isArray(parsed.system)
        ? parsed.system.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("\n")
        : "";
    return { system, firstUser: firstUserText(messages) };
  }
  const system = messages
    .filter((message) => message && message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n");
  return { system, firstUser: firstUserText(messages) };
}

function firstUserText(messages) {
  for (const message of messages) {
    if (message && message.role === "user") return contentText(message.content);
  }
  return "";
}

/**
 * A map from conversation identity to a stable session UUID.
 * Synchronous by design: concurrent forwards of the same conversation derive
 * the same id without coordination (the event loop never interleaves derive).
 */
export function createSessionIdMap({
  max = DEFAULT_MAX_ENTRIES,
  digest = () => createHash("sha256"),
  mint = () => randomUUID(),
} = {}) {
  /** Insertion-ordered: the first key is the least recently used. */
  const byKey = new Map();

  function derive({ orgId, model, system, firstUser }) {
    const key = digest()
      .update(String(orgId ?? ""))
      .update("\u0000")
      .update(String(model ?? ""))
      .update("\u0000")
      .update(String(system ?? ""))
      .update("\u0000")
      .update(String(firstUser ?? ""))
      .digest("hex");
    const existing = byKey.get(key);
    if (existing !== undefined) {
      // Refresh recency without minting a new id.
      byKey.delete(key);
      byKey.set(key, existing);
      return existing;
    }
    const id = mint();
    byKey.set(key, id);
    if (byKey.size > max) {
      const oldest = byKey.keys().next().value;
      byKey.delete(oldest);
    }
    return id;
  }

  return { derive, size: () => byKey.size };
}

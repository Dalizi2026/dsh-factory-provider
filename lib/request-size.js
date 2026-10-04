// Byte pressure is distinct from token pressure. This is a conservative local
// budget, not a claim about Factory's undocumented upstream body-size limit.
export const DEFAULT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const FACTORY_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

const bytes = value => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));

export function requestSizeBreakdown(parsed) {
  const messages = Array.isArray(parsed?.input) ? parsed.input : Array.isArray(parsed?.messages) ? parsed.messages : [];
  return {
    bodyBytes: bytes(parsed),
    systemBytes: bytes(parsed?.system ?? parsed?.instructions),
    toolsBytes: bytes(parsed?.tools),
    messagesBytes: bytes(Array.isArray(parsed?.input) ? parsed.input : parsed?.messages),
    largestMessageBytes: messages.reduce((largest, message) => Math.max(largest, bytes(message)), 0),
  };
}

/** Only provider failures, never arbitrary occurrences of the number 413. */
export function isRequestTooLarge(failure) {
  if (failure?.status === 413 || String(failure?.code) === "413") return true;
  const message = String(failure?.message ?? "");
  return /^413\b|\bHTTP(?:\s+error)?\s*413\b|request entity too large|payload too large|request body too large|failed to buffer the request body:\s*length limit exceeded/i.test(message);
}

/** Reduce only the detached transcript submitted for a summary. Keep every
 * message, system instruction, tool call/id/arguments and signed block intact.
 * A visible head/tail omission marker prevents presenting truncated text as
 * a complete transcript. Normal model requests and durable events are unchanged. */
export function smallerSummaryInput(input) {
  const messages = input.messages ?? [];
  const candidates = [];
  for (const [mi, message] of messages.entries()) {
    if (message.role === "system" || message.role === "developer" || mi === messages.length - 1) continue;
    for (const [bi, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (block.type === "text" && typeof block.text === "string" && Buffer.byteLength(block.text) > 8192) {
        candidates.push({ mi, bi, text: block.text });
      }
    }
  }
  if (!candidates.length) return null;
  const next = { ...input, messages: messages.map(message => ({ ...message, content: Array.isArray(message.content) ? [...message.content] : message.content })) };
  for (const { mi, bi, text } of candidates) {
    // Cut by characters, never in the middle of a UTF-8 byte sequence. Slices
    // are adjusted so a surrogate pair is not broken either.
    const retain = Math.max(1024, Math.floor(text.length / 4));
    let head = text.slice(0, retain), tail = text.slice(-retain);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    next.messages[mi].content[bi] = { ...messages[mi].content[bi], text: `${head}\n[Middle of long text omitted for request-size recovery; original remains in session history.]\n${tail}` };
  }
  return bytes(next) < bytes(input) ? next : null;
}

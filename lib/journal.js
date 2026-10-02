// Request journal shared by the gateway (writer) and the settings card (reader).
// One JSON line per forwarded call: what was asked, what came back. Never
// records tokens or full bodies. Capped at ~1 MB (truncated when exceeded).

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const JOURNAL_PATH = new URL("../journal.jsonl", import.meta.url);
const JOURNAL_MAX_BYTES = 1024 * 1024;

export function journal(entry) {
  try {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`;
    let existing = 0;
    try {
      existing = statSync(JOURNAL_PATH).size;
    } catch {
      /* not created yet */
    }
    if (existing > JOURNAL_MAX_BYTES) {
      writeFileSync(JOURNAL_PATH, "", { mode: 0o600 });
    }
    appendFileSync(JOURNAL_PATH, line, { mode: 0o600 });
  } catch {
    /* diagnostics must never break a request */
  }
}

/** The last `limit` entries, oldest first (empty when no journal yet). */
export function readJournal(limit = 50) {
  try {
    const text = readFileSync(JOURNAL_PATH, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { t: null, event: "unparseable" };
      }
    });
  } catch {
    return [];
  }
}

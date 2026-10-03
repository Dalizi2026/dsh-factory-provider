// Request journal shared by the gateway (writer) and the settings card (reader).
// One JSON line per forwarded call: what was asked, what came back. Never
// records tokens or full bodies. Capped at ~1 MB (truncated when exceeded).

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

const DEFAULT_JOURNAL_PATH = new URL("../journal.jsonl", import.meta.url);
const JOURNAL_MAX_BYTES = 1024 * 1024;

/** Where records go. Resolved per call, not at import, so a test can point it at
 *  a temp file (DSH_FACTORY_JOURNAL) instead of appending to the journal of a
 *  running host — deliberately broken handlers in a suite used to show up in
 *  the production log. */
export function journalPath() {
  const override = process.env.DSH_FACTORY_JOURNAL;
  return override === undefined || override.length === 0 ? DEFAULT_JOURNAL_PATH : override;
}

export function journal(entry) {
  try {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`;
    let existing = 0;
    try {
      existing = statSync(journalPath()).size;
    } catch {
      /* not created yet */
    }
    if (existing > JOURNAL_MAX_BYTES) {
      writeFileSync(journalPath(), "", { mode: 0o600 });
    }
    appendFileSync(journalPath(), line, { mode: 0o600 });
  } catch {
    /* diagnostics must never break a request */
  }
}

/** The last `limit` entries, oldest first (empty when no journal yet). */
export function readJournal(limit = 50) {
  try {
    const text = readFileSync(journalPath(), "utf8");
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

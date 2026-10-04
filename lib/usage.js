// Durable counters: no keys, prompts or replies. Time filters never delete data.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { journalPath } from './journal.js';
const DAY = 86400000;
export const TOKEN_STATS_RANGES = ['today', '24h', '7d', '30d', 'all'];
const FIELDS = ['input', 'output', 'read', 'write'];
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const date = ms => new Date(ms).toISOString().slice(0, 10);
const lines = filename => {
  try { return readFileSync(filename, 'utf8').split('\n').flatMap(line => {
    try { const value = line.trim() ? JSON.parse(line) : null; return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; } catch { return []; }
  }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

/** Local midnight includes DST; other ranges are rolling elapsed time. */
export function tokenStatsWindow(range = 'today', timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now()) {
  if (!TOKEN_STATS_RANGES.includes(range)) throw new RangeError('Unknown token statistics range');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  if (range === 'all') return { start: 0, end: now, timeZone };
  if (range !== 'today') return { start: now - ({ '24h': 1, '7d': 7, '30d': 30 }[range] * DAY), end: now, timeZone };
  const today = formatter.format(now);
  let low = now - 2 * DAY, high = now;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (formatter.format(mid) === today) high = mid; else low = mid;
  }
  return { start: high, end: now, timeZone };
}

function normalize(entry, now) {
  if (entry?.event !== 'usage' || typeof entry.model !== 'string' || !entry.model || entry.model.length > 256) return undefined;
  const timestamp = Date.parse(entry.t);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) return undefined;
  const counts = Object.fromEntries(FIELDS.map(field => [field, validCount(entry[field]) ? entry[field] : null]));
  if (counts.write === null && validCount(entry.write5m) && validCount(entry.write1h)) counts.write = entry.write5m + entry.write1h;
  if (!FIELDS.some(field => counts[field] !== null)) return undefined;
  const id = typeof entry.requestId === 'string' && entry.requestId.length > 0 && entry.requestId.length <= 256 ? entry.requestId :
    createHash('sha256').update(JSON.stringify([entry.t, entry.route, entry.model, counts])).digest('hex');
  return { t: new Date(timestamp).toISOString(), id, model: entry.model, ...counts };
}

export function createTokenUsageStore({ directory, legacyPath, now = Date.now }) {
  let ready = false, metadata;
  const known = new Map();
  const filename = day => path.join(directory, `${day}.jsonl`);
  function remember(day) {
    const file = filename(day);
    let size = 0; try { size = statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let cache = known.get(day);
    if (!cache || cache.size !== size) { cache = { size, ids: new Set(lines(file).map(row => row.id)) }; known.set(day, cache); }
    return cache;
  }
  function append(record) {
    const day = record.t.slice(0, 10), cache = remember(day);
    if (cache.ids.has(record.id)) return false;
    const line = JSON.stringify(record) + '\n';
    appendFileSync(filename(day), line, { mode: 0o600 });
    cache.ids.add(record.id); cache.size += Buffer.byteLength(line); return true;
  }
  function initialize() {
    if (ready) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metaFile = path.join(directory, 'metadata.json');
    try { metadata = JSON.parse(readFileSync(metaFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const started = now(); let imported = 0, oldest = started;
      for (const entry of legacyPath ? lines(legacyPath) : []) {
        const record = normalize(entry, started);
        if (record && append(record)) { imported++; oldest = Math.min(oldest, Date.parse(record.t)); }
      }
      metadata = { schema: 1, createdAt: new Date(started).toISOString(), availableSince: new Date(oldest).toISOString(), imported };
      writeFileSync(metaFile, JSON.stringify(metadata) + '\n', { mode: 0o600 });
    }
    if (metadata?.schema !== 1 || !Number.isFinite(Date.parse(metadata.availableSince)) || !validCount(metadata.imported)) {
      throw new Error('Invalid token statistics metadata');
    }
    ready = true;
  }
  return {
    record(entry) {
      const normalized = normalize(entry, now()); if (!normalized) return false;
      initialize();
      const added = append(normalized);
      if (added && normalized.t < metadata.availableSince) {
        metadata.availableSince = normalized.t;
        writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata) + '\n', { mode: 0o600 });
      }
      return added;
    },
    read({ range = 'today', timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
      const window = tokenStatsWindow(range, timeZone, now()); initialize();
      const models = new Map(), seen = new Set(); let lastUpdatedAt = null;
      const firstDay = date(window.start), lastDay = date(window.end);
      for (const name of readdirSync(directory).sort()) {
        const day = name.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || day < firstDay || day > lastDay) continue;
        for (const record of lines(path.join(directory, name))) {
          const timestamp = Date.parse(record.t);
          if (!Number.isFinite(timestamp) || timestamp < window.start || timestamp > window.end ||
              typeof record.id !== 'string' || seen.has(record.id) || typeof record.model !== 'string' || !record.model) continue;
          if (!FIELDS.some(field => validCount(record[field]))) continue;
          seen.add(record.id);
          let row = models.get(record.model);
          if (!row) { row = { model: record.model, input: null, output: null, read: null, write: null, total: 0, requests: 0, partial: false }; models.set(record.model, row); }
          for (const field of FIELDS) {
            if (validCount(record[field])) { row[field] = (row[field] ?? 0) + record[field]; row.total += record[field]; }
            else row.partial = true;
          }
          row.requests++; if (lastUpdatedAt === null || record.t > lastUpdatedAt) lastUpdatedAt = record.t;
        }
      }
      return { range, timeZone: window.timeZone, start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString(),
        availableSince: metadata.availableSince,
        importedRecords: metadata.imported, retentionDays: null, lastUpdatedAt,
        rows: [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)) };
    },
  };
}

export function tokenUsageDirectory() {
  if (process.env.DSH_FACTORY_USAGE_DIR) return process.env.DSH_FACTORY_USAGE_DIR;
  if (process.env.DSH_FACTORY_JOURNAL) return `${process.env.DSH_FACTORY_JOURNAL}.usage`;
  return path.join(os.homedir(), '.dsh-factory-provider', 'token-usage');
}
let cachedDirectory, cachedStore;
function currentStore() {
  const directory = tokenUsageDirectory();
  if (directory !== cachedDirectory) { cachedStore = createTokenUsageStore({ directory, legacyPath: journalPath() }); cachedDirectory = directory; }
  return cachedStore;
}
export function recordTokenUsage(entry) {
  try { currentStore().record(entry); return true; } catch { return false; }
}
export function readTokenStats(options) { return currentStore().read(options); }
export function createTokenStatsHandler({ read = readTokenStats, reply }) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(res, 405, { ok: false, code: 'method_not_allowed', error: { message: 'token statistics is GET' } }); return;
    }
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const range = params.get('range') ?? 'today';
      const timeZone = params.get('timeZone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      reply(res, 200, { ok: true, value: read({ range, timeZone }) });
    } catch (error) {
      reply(res, error instanceof RangeError ? 400 : 500, { ok: false,
        code: error instanceof RangeError ? 'invalid_statistics_window' : 'statistics_unavailable',
        error: { message: error instanceof RangeError ? 'Invalid time range or time zone' : 'Token statistics could not be read' } });
    }
  };
}

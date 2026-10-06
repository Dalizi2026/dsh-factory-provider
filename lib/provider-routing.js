// Official O7/M/I/uI ordering: configured model -> family defaults -> registry
// first, then intersect region eligibility and remove blocked providers. A
// registered backend is NOT automatically a failover candidate. The bundled
// snapshot keeps installs independent of Droid; production refreshes it with
// the selected key's own feature flags (desktop and API-key orders can differ).
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const data = JSON.parse(readFileSync(new URL('./provider-routing-data.json', import.meta.url), 'utf8'));
export const FACTORY_ATTEMPT_HEADER = 'x-dsh-factory-attempt';
export const FACTORY_PREVIOUS_FAILURE_HEADER = 'x-dsh-factory-previous-transport-failure';

export const PROVIDER_ROUTING_DATA = data;
const paths = {
  anthropic: ['anthropic', 'vertex_anthropic', 'bedrock_anthropic', 'azure_anthropic', 'snowflake'],
  openai: ['openai', 'azure_openai', 'bedrock_openai', 'snowflake', 'databricks'],
  generic: ['fireworks', 'baseten', 'databricks', 'mistral'],
};
const hash = text => createHash('sha256').update(text).digest('hex');
const list = value => Array.isArray(value) ? [...new Set(value.filter(p => typeof p === 'string' && Object.hasOwn(data.providerRegions, p)))] : [];

export function sanitizeRoutingConfig(value) {
  if (value?.version !== 1 || !value.defaults || !value.models || typeof value.models !== 'object') return undefined;
  const defaults = Object.fromEntries(['anthropic', 'openai', 'factory'].map(f => [f, list(value.defaults[f])]));
  const models = {}, blockedProviders = {};
  for (const id of Object.keys(data.models)) {
    if (Array.isArray(value.models[id])) models[id] = list(value.models[id]);
    if (Array.isArray(value.blockedProviders?.[id])) blockedProviders[id] = list(value.blockedProviders[id]);
  }
  return { version: 1, defaults, models, blockedProviders };
}

export function providerOrder(model, { config = data.config, region = 'global', route = data.models[model]?.route } = {}) {
  const entry = data.models[model];
  if (!entry || entry.route !== route || !['global', 'eu', 'us'].includes(region)) return [];
  const registered = new Set(entry.providers);
  const configured = list(config.models?.[model]).filter(p => registered.has(p));
  const defaults = list(config.defaults?.[entry.family]).filter(p => registered.has(p));
  const ordered = configured.length ? configured : defaults.length ? defaults : entry.providers.slice(0, 1);
  const allowed = new Set(entry.regionOverrides?.[region] ?? entry.providers.filter(p => data.providerRegions[p]?.includes(region)));
  const blocked = new Set(list(config.blockedProviders?.[model]));
  const eligible = p => allowed.has(p) && !blocked.has(p) && paths[route]?.includes(p);
  const candidates = ordered.filter(eligible);
  // Official I fallback is the FIRST eligible registered provider, not every
  // provider absent from the account's configured failover order.
  return candidates.length ? candidates : entry.providers.filter(eligible).slice(0, 1);
}

export function retryableProviderStatus(status) { return status === 429 || status >= 500 && status <= 599; }
export function streamFailure(event) {
  const error = event?.error ?? (event?.type === 'response.failed' ? event?.response?.error : undefined);
  if (!error || typeof error !== 'object') return undefined;
  const type = error.type ?? error.code;
  if (type === 'overloaded_error' || type === 'server_error' || type === 'api_error') return 'SERVER';
  if (type === 'rate_limit_error' || type === 'rate_limit_exceeded') return 'RATE_LIMIT';
  return undefined;
}

export function createProviderRouter({ fetchConfig, config = data.config, preferAnthropic = false, now = Date.now, maxSessions = 500, maxAccounts = 20 } = {}) {
  const fallback = sanitizeRoutingConfig(config) ?? sanitizeRoutingConfig(data.config);
  const accounts = new Map(), sessions = new Map();
  let anthropicPreferred = preferAnthropic === true, lastClaudeSelection;
  let apiHost = 'https://api.factory.ai';
  const touch = (map, key, value, limit) => {
    map.delete(key); map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  };
  async function accountConfig(credential) {
    if (!fetchConfig) return { config: fallback, source: 'bundled_snapshot' };
    const key = hash(`${apiHost}\0${credential.token}\0${credential.orgId ?? ''}`);
    let entry = accounts.get(key);
    if (!entry) entry = { config: fallback, source: 'bundled_snapshot', expires: 0 };
    touch(accounts, key, entry, maxAccounts);
    if (entry.pending) { await entry.pending; return entry; }
    if (entry.expires > now()) return entry;
    entry.pending = (async () => {
      try {
        const headers = { authorization: `Bearer ${credential.token}`, 'x-factory-client': 'cli', 'x-client-version': data.source.cliVersion };
        if (credential.orgId) headers['X-Factory-Org-Id'] = credential.orgId;
        const response = await fetchConfig(`${apiHost}/api/feature-flags`, { headers, signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('Routing flags unavailable');
        const body = await response.json();
        const next = sanitizeRoutingConfig(body?.configs?.provider_routing);
        if (!next) throw new Error('Routing flags schema unsupported');
        entry.config = next; entry.source = 'account_feature_flags'; entry.expires = now() + 300000;
      } catch {
        // Keep the last verified account config during an outage. Never read
        // another app's personal credential/config cache as a runtime fallback.
        entry.expires = now() + 60000;
      }
    })();
    await entry.pending; delete entry.pending;
    return entry;
  }
  async function select({ credential, model, route, session, host, region = 'global', attempt, previousFailure }) {
    const snapshot = await accountConfig(credential);
    const officialOrder = providerOrder(model, { route, region, config: snapshot.config });
    const preferred = anthropicPreferred && route === 'anthropic';
    const preferenceApplied = preferred && officialOrder.includes('anthropic');
    const order = preferenceApplied ? ['anthropic', ...officialOrder.filter(p => p !== 'anthropic')] : officialOrder;
    if (!order.length) return undefined;
    const key = hash(`${credential.token}\0${credential.orgId ?? ''}\0${host}\0${region}\0${route}\0${model}\0${session}`);
    let state = sessions.get(key);
    if (!state) state = { provider: order[0], route, locked: false, revision: 0, origins: new Map() };
    if (!order.includes(state.provider)) { state.provider = order[0]; state.locked = false; state.revision++; }
    // A DSH idle timeout aborts fetch exactly like a user cancellation. Only
    // the adapter's NEXT request can confirm that the prior attempt timed out.
    // Match its per-call ticket; never rotate on an ordinary user cancellation,
    // a stale ticket, or a failure already handled by HTTP/SSE observation.
    if (previousFailure && previousFailure === state.ticket && !['complete', 'failed'].includes(state.outcome)) {
      state.provider = order[(order.indexOf(state.provider) + 1) % order.length];
      state.locked = false; state.revision++;
    }
    state.ticket = attempt; state.outcome = 'pending';
    touch(sessions, key, state, maxSessions);
    const decision = { provider: state.provider, order, revision: state.revision,
      source: state.locked ? 'session_lock' : preferenceApplied ? 'preferred_order' : 'configured_order', configSource: snapshot.source,
      preferenceApplied, preferenceReason: preferred && !preferenceApplied ? 'anthropic_unavailable' : undefined };
    if (route === 'anthropic') lastClaudeSelection = { model, provider: decision.provider, preferenceApplied,
      preferenceReason: decision.preferenceReason };
    decision.failure = () => {
      if (state.provider !== decision.provider || state.revision !== decision.revision || state.ticket !== attempt) return undefined;
      const next = order[(order.indexOf(decision.provider) + 1) % order.length];
      state.provider = next; state.locked = false; state.revision++; state.outcome = 'failed';
      return next !== decision.provider ? next : undefined;
    };
    decision.success = () => {
      if (state.provider === decision.provider && state.revision === decision.revision && state.ticket === attempt) {
        state.locked = true; state.lastSuccess = decision.provider; state.outcome = 'complete';
      }
    };
    // Official o3 drops encrypted reasoning metadata from a different API
    // route. Remember provenance across a switch so old encrypted items are
    // not reintroduced on the following turn; text and tool pairs stay intact.
    decision.prepare = parsed => {
      if (route !== 'openai' || !Array.isArray(parsed.input) || !state.lastSuccess) return;
      parsed.input = parsed.input.filter(item => {
        if (item?.type !== 'reasoning' || typeof item.encrypted_content !== 'string') return true;
        const id = hash(item.encrypted_content);
        if (!state.origins.has(id)) touch(state.origins, id, state.lastSuccess, 500);
        return state.origins.get(id) === decision.provider;
      });
    };
    return decision;
  }
  return { select, configure({ host, preferAnthropic } = {}) {
      if (typeof host === 'string' && host) apiHost = host.replace(/\/+$/, '');
      if (typeof preferAnthropic === 'boolean' && preferAnthropic !== anthropicPreferred) {
        anthropicPreferred = preferAnthropic; lastClaudeSelection = undefined;
        // Preferences set the first choice for new sessions. Existing healthy
        // sessions keep their provider even when the user changes this switch.
      }
    },
    status: () => ({ enabled: true, registryVersion: data.source.cliVersion, snapshotDate: data.source.routingSnapshotDate,
      accountConfigs: accounts.size, sessions: sessions.size, accountScopedRefresh: Boolean(fetchConfig),
      preferAnthropic: anthropicPreferred, lastClaudeSelection }) };
}

/** No nested retry loop: DSH owns retry count/delay. Only a recognized
 * overload BEFORE content becomes retryable; partial replies are not replayed. */
export async function* normalizeFactoryFailures(stream, signal, onFinish) {
  let emittedContent = false;
  for await (const chunk of stream) {
    if (['block-start', 'block-end', 'text-delta', 'thinking-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk?.type)) emittedContent = true;
    const failure = chunk?.type === 'finish' && chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined;
    if (chunk?.type === 'finish') onFinish?.({ failure, emittedContent });
    if (!emittedContent && !signal?.aborted && failure?.code === 'PI_AI_ERROR') {
      let code;
      try { code = streamFailure(JSON.parse(failure.message)); } catch { /* unknown errors remain unchanged */ }
      if (code) { yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code } } }; continue; }
    }
    yield chunk;
  }
}

export function createRoutingAttemptTracker() {
  const sessions = new Map();
  return { prepare(options, snapshot) {
    const ticket = randomUUID();
    const key = typeof options.sessionId === 'string' || typeof options.sessionId === 'number'
      ? hash(`${options.provider}\0${options.model}\0${options.sessionId}`) : undefined;
    const previous = key ? sessions.get(key)?.failure : undefined;
    if (key) {
      sessions.delete(key); sessions.set(key, { ticket });
      while (sessions.size > 500) sessions.delete(sessions.keys().next().value);
    }
    const profiles = new Map(snapshot.profiles), profile = profiles.get(options.provider);
    const headers = { ...profile?.headers, [FACTORY_ATTEMPT_HEADER]: ticket };
    delete headers[FACTORY_PREVIOUS_FAILURE_HEADER];
    if (previous) headers[FACTORY_PREVIOUS_FAILURE_HEADER] = previous;
    profiles.set(options.provider, { ...profile, headers });
    return { snapshot: { ...snapshot, profiles }, finish({ failure, emittedContent }) {
      if (!key || sessions.get(key)?.ticket !== ticket) return;
      if (!emittedContent && !options.signal?.aborted && ['TIMEOUT', 'TRANSPORT'].includes(failure?.code)) {
        sessions.get(key).failure = ticket;
      } else sessions.delete(key);
    } };
  } };
}

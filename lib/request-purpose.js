import { createHash } from 'node:crypto';
// Local adapter-to-gateway metadata. These headers never reach Factory.
export const FACTORY_REQUEST_PURPOSE_HEADER = "x-dsh-factory-purpose";
export const FACTORY_REQUEST_SESSION_HEADER = "x-dsh-factory-session";

/** A detached profile preserves other calls and prepared model generations. */
export function scopeFactoryRequest(snapshot, options) {
  if (!['factory-a', 'factory-g', 'factory-o'].includes(options.provider)) return snapshot;
  const headers = {};
  if (options.provider === 'factory-a' && options.purpose === 'compaction') headers[FACTORY_REQUEST_PURPOSE_HEADER] = 'compaction';
  if (typeof options.sessionId === 'string' || typeof options.sessionId === 'number') {
    headers[FACTORY_REQUEST_SESSION_HEADER] = createHash('sha256').update(String(options.sessionId)).digest('hex');
  }
  if (!Object.keys(headers).length) return snapshot;
  const profile = snapshot.profiles.get(options.provider);
  const profiles = new Map(snapshot.profiles);
  profiles.set(options.provider, { ...profile,
    headers: { ...profile?.headers, ...headers },
  });
  return { ...snapshot, profiles };
}

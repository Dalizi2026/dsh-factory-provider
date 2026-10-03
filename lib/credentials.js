// Credential resolution for the Factory gateway.
//
// This plugin authenticates with a Factory API key (`fk-…`) and nothing else.
// A key is long-lived, so there is no envelope to decrypt, no OS keyring to
// read and no OAuth refresh to perform — which is also why the plugin works the
// same on macOS, Windows and Linux.
//
// Verified against the live service (2026-10-03): the same key is accepted as a
// bearer token by the inference host AND by the billing endpoint, and it
// reports the same subscription windows as a droid CLI login — so it draws on
// the same subscription quota. Factory's public API documentation only ever
// describes keys as authenticating api.factory.ai, so this is an undocumented
// capability of the same account.

/**
 * Single-flight credential resolver. Order per resolve():
 *   1. the key selected in the settings page
 *   2. `FACTORY_API_KEY` (the harness credential store first, then the process
 *      environment) while no key is selected
 *   3. nothing — `state()` explains which case applied
 * `state()` reports what the last resolution decided, for the status route.
 */
export function createTokenResolver({
  keyEnv = "FACTORY_API_KEY",
  resolveKey,
  activeKey,
  disabled,
} = {}) {
  let inFlight = undefined;
  let last = undefined; // { token, source, orgId }
  let generation = 0;

  async function resolveOnce() {
    // 1. the key the user selected wins over every ambient source: they picked
    //    it, so a leftover environment variable may not override the choice.
    const selected = activeKey?.();
    if (typeof selected === "string" && selected.length > 0) {
      return { token: selected, source: "api-key", orgId: undefined };
    }
    // 2. an explicitly disabled plugin serves nothing at all.
    if (disabled?.() === true) {
      return { token: undefined, source: "disabled", orgId: undefined };
    }
    // 3. ambient key: the harness credential store, then the environment.
    if (resolveKey) {
      try {
        const key = await resolveKey(keyEnv);
        if (typeof key === "string" && key.length > 0) {
          return { token: key, source: "api-key", orgId: undefined };
        }
      } catch {
        /* fall through to the environment */
      }
    }
    const envKey = process.env[keyEnv];
    if (typeof envKey === "string" && envKey.length > 0) {
      return { token: envKey, source: "api-key", orgId: undefined };
    }
    return { token: undefined, source: "none", orgId: undefined };
  }

  return {
    /** Resolve a usable credential. Concurrent callers share one resolution. */
    async resolve() {
      if (last?.token !== undefined) return last;
      if (inFlight !== undefined) return inFlight;
      const gen = generation;
      let task;
      task = resolveOnce()
        .catch(() => ({ token: undefined, source: "error", orgId: undefined }))
        .then((result) => {
          // A reset() while this was in flight means the selection changed, so
          // the answer belongs to a stale generation and must not be cached:
          // committing it here would serve the previous key to later callers.
          if (gen !== generation) {
            return { token: undefined, source: "switched", orgId: undefined };
          }
          last = result;
          return result;
        })
        .finally(() => {
          // Only the task that still owns the slot may clear it, or a stale
          // task would drop a newer one and break single-flight.
          if (inFlight === task) inFlight = undefined;
        });
      inFlight = task;
      return task;
    },
    /** Drop the cached credential and resolve again (used after an upstream 401). */
    async forceRefresh() {
      // A 401 says the cached answer is no good, and a resolution already in
      // flight may be carrying that same answer — so it is discarded rather
      // than reused.
      generation += 1;
      last = undefined;
      inFlight = undefined;
      return this.resolve();
    },
    /** Drop the cached credential because the selection changed. A resolve
     *  already in flight is discarded via the generation counter. */
    reset() {
      generation += 1;
      last = undefined;
      inFlight = undefined;
    },
    /** A key never expires, so there is nothing to refresh proactively. */
    async tick() {},
    state() {
      return last === undefined
        ? { source: "unknown" }
        : { source: last.source, expiresAt: undefined, orgId: last.orgId };
    },
  };
}

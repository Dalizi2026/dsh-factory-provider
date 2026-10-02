// Factory subscription quota windows, read from the account's billing endpoint.
// The same token the gateway forwards with doubles as the billing credential.

const BILLING_PATH = "/api/billing/limits";

/** Shape one window for display. */
function windowView(window) {
  if (window === undefined || window === null) return undefined;
  return {
    usedPercent: Number(window.usedPercent ?? 0),
    windowEnd: typeof window.windowEnd === "string" ? window.windowEnd : null,
    secondsRemaining:
      typeof window.secondsRemaining === "number" ? window.secondsRemaining : null,
  };
}

/** Fetch and normalize the account's rolling quota buckets.
 * `credential` (`{ token, orgId }`) bypasses the resolver — used for
 * per-account quota in the accounts panel. Returns `{ ok: true, value }` or
 * `{ ok: false, code, message }` — never throws, so the settings card can
 * render a reason instead of an empty panel. */
export async function fetchQuota({ resolver, credential, fetchImpl = fetch, host = "https://api.factory.ai", now = Date.now } = {}) {
  const resolved = credential ?? (await resolver?.resolve());
  if (resolved?.token === undefined) {
    return resolved?.source === "disabled"
      ? {
          ok: false,
          code: "disabled",
          message: "凭据已停用（正在使用的账号已删除）——选择账号或切回默认登录后恢复",
        }
      : { ok: false, code: "no-credential", message: "未检测到 Factory 登录态" };
  }
  const headers = {
    authorization: `Bearer ${resolved.token}`,
    "x-client-version": "0.231.0",
    "x-factory-client": "cli",
    accept: "application/json",
    "accept-encoding": "identity",
  };
  if (resolved.orgId) headers["x-factory-org-id"] = resolved.orgId;
  try {
    const res = await fetchImpl(`${host.replace(/\/+$/, "")}${BILLING_PATH}`, { headers });
    if (!res.ok) {
      return { ok: false, code: `http-${res.status}`, message: `Factory 账目端点返回 ${res.status}` };
    }
    const body = await res.json();
    const limits = body?.limits ?? {};
    return {
      ok: true,
      value: {
        fetchedAt: now(),
        tokenRateLimits: body?.usesTokenRateLimitsBilling === true,
        overagePreference: typeof body?.overagePreference === "string" ? body.overagePreference : null,
        extraUsageAllowed: body?.extraUsageAllowed === true,
        extraUsageBalanceCents: Number(body?.extraUsageBalanceCents ?? 0),
        standard: {
          fiveHour: windowView(limits.standard?.fiveHour),
          weekly: windowView(limits.standard?.weekly),
          monthly: windowView(limits.standard?.monthly),
        },
        core: {
          fiveHour: windowView(limits.core?.fiveHour),
          weekly: windowView(limits.core?.weekly),
          monthly: windowView(limits.core?.monthly),
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

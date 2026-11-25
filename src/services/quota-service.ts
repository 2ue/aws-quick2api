import {
  fetchOAuthProfileUsage,
  deriveStableOutpostId,
  QUICK_APP_VERSION,
  sanitizeAwsQuickWsHost,
  fetchOAuthUserIdentity,
  getCachedOAuthUserIdentity,
  listOAuthCloudSessions,
  resolveOAuthAccessToken,
} from "../aws-quick/oauth-client.js";
import { getSharedOutpost, parseQuickCredential } from "../aws-quick/outpost-singleton.js";
import { fetchWebProfileUsage, listWebCloudSessions } from "../aws-quick/web-client.js";
import { maskSecretKey } from "../core/key-pool.js";
import { parseResetTime } from "../core/limit-policy.js";
import type { QuickQuotaUsage } from "../aws-quick/types.js";
import { fetchViaOptionalProxy } from "../utils/proxy-agent.js";
import crypto from "node:crypto";

export interface QuickPlanQuotaView {
  membershipType: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  daysRemainingInCycle?: number;
  trialExpiresAt?: string;
  trialDaysRemaining?: number;
  autoDisplayMessage?: string;
  apiDisplayMessage?: string;
  /** AWS Quick Session usage pool */
  sessionPool: {
    usedPercent: number | null;
    remainingPercent: number | null;
    resetAt?: string;
  };
  /** AWS Quick Monthly usage pool (minutes) */
  premiumApiPool: {
    usedPercent: number | null;
    remainingPercent: number | null;
  };
  overallIncludedPlan: {
    usedPercent: number | null;
    remainingPercent: number | null;
    allowanceUsd: number | null;
    breakdownUsd?: {
      includedUsd: number;
      bonusUsd: number;
      totalUsd: number;
    };
  };
  onDemandSpend: {
    enabled: boolean;
    usedUsd: number;
    limitUsd: number | null;
    remainingUsd: number | null;
  };
}

export interface BotQuotaView {
  hasLimit: boolean;
  usedPercent: number | null;
  remainingPercent: number | null;
  hasAvailableUsage: boolean;
  periodStart?: string;
  resetAt?: string;
}

export interface AccountQuotaReport {
  maskedKey: string;
  status: "ok" | "error";
  bot?: BotQuotaView;
  cloudSessionCount?: number | null;
  tokenRemainingSec?: number | null;
  identity?: {
    apiKeyName: string;
    userEmail?: string;
    displayName?: string;
    userId?: number;
    createdAt: string;
  };
  quota?: QuickPlanQuotaView;
  error?: string;
}

const summaryCache = new Map<string, { report: AccountQuotaReport; expiresAtMs: number }>();
const SUMMARY_CACHE_TTL_MS = 30_000;

export function evictQuotaCachesForKey(apiKey: string): void {
  summaryCache.delete(apiKey);
}

function formatMinutesAsHours(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}


function parseUsagePool(pool: QuickQuotaUsage["session"] | QuickQuotaUsage["monthly"]) {
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim());
  const used = Number(pool?.used);const limit = Number(pool?.limit);
  const known = numeric(pool?.used) && numeric(pool?.limit) && used >= 0 && limit > 0;
  const percent = known ? Math.min(100, Math.round(used / limit * 1000) / 10) : null;
  const remaining = known ? used >= limit ? 0 : Math.max(0.1, Math.round((1 - used / limit) * 1000) / 10) : null;
  return { used, limit, percent, remaining, known };
}

export function parseQuickPlanQuota(usage: QuickQuotaUsage, now = Date.now()): QuickPlanQuotaView {
    const session = parseUsagePool(usage.session);
    const sessUsed = session.used;const sessLimit = session.limit;const sessPct = session.percent;

    const monthly = parseUsagePool(usage.monthly);
    const monUsed = monthly.used;const monLimit = monthly.limit;const monPct = monthly.percent;

    const monthlyResetMs = parseResetTime(usage.monthly?.resets_at, now);
    const sessionResetMs = parseResetTime(usage.session?.resets_at, now);
    const billingCycleEnd = monthlyResetMs ? new Date(monthlyResetMs).toISOString() : undefined;
    const daysRemainingInCycle = monthlyResetMs
      ? Math.max(0, Math.ceil((monthlyResetMs - now) / 86_400_000))
      : undefined;

    const trialEpoch = typeof usage.subscription?.free_trial_metadata?.expiry_date === "number"
      ? usage.subscription.free_trial_metadata.expiry_date
      : undefined;
    const trialExpiresAt = trialEpoch ? new Date(trialEpoch * 1000).toISOString() : undefined;
    const trialDaysRemaining = trialEpoch
      ? Math.max(0, Math.ceil((trialEpoch * 1000 - now) / 86_400_000))
      : undefined;

    const subType = usage.subscription?.subscription_type || "AWS_QUICK";

    return {
        membershipType: subType,
        billingCycleEnd,
        daysRemainingInCycle,
        ...(trialExpiresAt ? { trialExpiresAt } : {}),
        ...(trialDaysRemaining !== undefined ? { trialDaysRemaining } : {}),
        autoDisplayMessage: session.known ? `Session ${sessUsed}/${sessLimit}` : "Session usage unavailable",
        apiDisplayMessage: monthly.known ? `Monthly ${formatMinutesAsHours(monUsed)} / ${formatMinutesAsHours(monLimit)}` : "Monthly usage unavailable",
        sessionPool: {
          usedPercent: sessPct,
          remainingPercent: session.remaining,
          ...(sessionResetMs ? { resetAt: new Date(sessionResetMs).toISOString() } : {}),
        },
        premiumApiPool: {
          usedPercent: monPct,
          remainingPercent: monthly.remaining,
        },
        overallIncludedPlan: {
          usedPercent: monPct,
          remainingPercent: monthly.remaining,
          allowanceUsd: null,
        },
        onDemandSpend: {
          enabled: false,
          usedUsd: 0,
          limitUsd: null,
          remainingUsd: null,
        },
      };
}

async function fetchSingleAwsQuickQuota(
  apiKey: string,
  force = false,
  proxyUrl?: string,
): Promise<AccountQuotaReport> {
  const now = Date.now();
  if (!force) {
    const cached = summaryCache.get(apiKey);
    if (cached && cached.expiresAtMs > now) return cached.report;
  }

  const maskedKey = maskSecretKey(apiKey);
  try {
    const cred = parseQuickCredential(apiKey);
    let usage;
    let cloudSessions;
    let accountId: string | undefined;
    let region: string | undefined = "us-east-1";
    let tokenRemainingSec: number | null = null;
    let apiKeyName = "local-outpost";

    let userEmail: string | undefined;
    let displayName: string | undefined;

    if (cred.mode === "oauth" && cred.oauth) {
      apiKeyName = "oauth-pkce (90d)";
      region = cred.oauth.region || "us-east-1";
      accountId = cred.oauth.accountId || cred.oauth.clientId.slice(0, 12);
      const cachedId = getCachedOAuthUserIdentity(cred.oauth.clientId);
      const needIdentityProbe = (!cred.oauth.email && !cachedId?.email) || (!cred.oauth.name && !cachedId?.name);
      const [tok, u, cs, probedId] = await Promise.all([
        resolveOAuthAccessToken(cred.oauth, force, proxyUrl),
        fetchOAuthProfileUsage(cred.oauth, proxyUrl),
        listOAuthCloudSessions(cred.oauth, 100, proxyUrl).catch(() => null),
        needIdentityProbe ? fetchOAuthUserIdentity(cred.oauth, proxyUrl).catch(() => null) : Promise.resolve(null),
      ]);
      usage = u;
      cloudSessions = cs;
      tokenRemainingSec = Math.max(0, Math.floor((tok.expiresAt - now) / 1000));
      const resolvedId = probedId || cachedId;
      userEmail = cred.oauth.email || resolvedId?.email;
      displayName = cred.oauth.name || resolvedId?.name;
      if (resolvedId?.accountId) accountId = resolvedId.accountId;
    } else if (cred.mode === "web" && cred.web) {
      apiKeyName = "web-cookie";
      accountId = cred.web.accountId;
      const [u, cs] = await Promise.all([
        fetchWebProfileUsage(cred.web, proxyUrl),
        listWebCloudSessions(cred.web, 100, proxyUrl).catch(() => null),
      ]);
      usage = u;
      cloudSessions = cs;
    } else {
      apiKeyName = cred.mode === "outpost" ? "local-outpost" : "imported-token";
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      const [session, u, cs] = await Promise.all([
        outpost.getSncsSession(force),
        outpost.getProfileUsage(),
        outpost.listCloudSessions(100).catch(() => null),
      ]);
      usage = u;
      cloudSessions = cs;
      accountId = session.accountId;
      region = session.region || "us-east-1";
      tokenRemainingSec = session.usableUntil
        ? Math.max(0, Math.floor(session.usableUntil - now / 1000))
        : null;
    }

    const report: AccountQuotaReport = {
      maskedKey,
      status: "ok",
      cloudSessionCount: cloudSessions ? cloudSessions.length : null,
      tokenRemainingSec,
      identity: {
        apiKeyName,
        userEmail: userEmail || (accountId ? `aws:${accountId} (${region})` : region),
        ...(displayName ? { displayName } : {}),
        createdAt: new Date(now).toISOString(),
      },
      quota: parseQuickPlanQuota(usage, now),
    };

    summaryCache.set(apiKey, { report, expiresAtMs: now + SUMMARY_CACHE_TTL_MS });
    return report;
  } catch (err) {
    return {
      maskedKey,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchAllAccountQuotas(
  apiKeys: string[],
  options?: {
    force?: boolean;
    forceRefresh?: boolean;
    meFetcher?: unknown;
    fetchImpl?: unknown;
    fetcher?: unknown;
    proxyByKey?: (apiKey: string) => string | undefined;
  },
): Promise<AccountQuotaReport[]> {
  const results = new Array<AccountQuotaReport>(apiKeys.length);
  const force = Boolean(options?.force || options?.forceRefresh);
  const concurrency = Math.min(4, Math.max(1, apiKeys.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < apiKeys.length) {
      const idx = cursor++;
      const key = apiKeys[idx]!;
      results[idx] = await fetchSingleAwsQuickQuota(key, force, options?.proxyByKey?.(key));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/** Only usage is requested: no identity probe, session listing, or forced OAuth refresh. */
export async function fetchAccountUsageQuota(apiKey: string, signal: AbortSignal, proxyUrl?: string): Promise<QuickPlanQuotaView> {
  signal.throwIfAborted();
  const cred = parseQuickCredential(apiKey);
  let usage: QuickQuotaUsage;
  if (cred.mode === "oauth" && cred.oauth) {
    usage = await fetchOAuthProfileUsage(cred.oauth, proxyUrl, signal);
  } else if (cred.mode === "web" && cred.web) {
    usage = await fetchWebProfileUsage(cred.web, proxyUrl, signal);
  } else if (cred.mode === "token" && cred.jwt && cred.wsHost) {
    const host = sanitizeAwsQuickWsHost(cred.wsHost);
    const response = await fetchViaOptionalProxy(`https://${host}/integration/quick-work/qbs-event`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.jwt}`, "x-amzn-qs-internal-trace-id": crypto.randomUUID() },
      body: JSON.stringify({ eventType: "invokeAgent", eventBody: { invokeAgent: {
        path: "profile/usage", queryParams: { surfaceType: "QUICK_WORK_DESKTOP_MAC", appVersion: QUICK_APP_VERSION, _method: "GET" },
        body: {}, outpostId: cred.outpostId || deriveStableOutpostId(cred.jwt),
      } } }),
    }, proxyUrl);
    if (!response.ok) throw new Error(`Quota usage query failed (${response.status})`);
    const envelope = await response.json() as { eventResponse?: { invokeAgentResponse?: string | { body?: string } } };
    const raw = envelope?.eventResponse?.invokeAgentResponse;
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
    usage = typeof result?.body === "string" ? JSON.parse(result.body) : {};
  } else {
    throw new Error("Automatic quota lookup requires OAuth, Web Cookie or a token with its AWS Quick host; existing cooldown retained.");
  }
  signal.throwIfAborted();
  if (!usage || typeof usage !== "object") throw new Error("Invalid quota usage response");
  return parseQuickPlanQuota(usage);
}

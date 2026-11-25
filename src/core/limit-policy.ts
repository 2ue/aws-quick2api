import type { GatewayError } from "./types.js";

export interface AccountLimit {
  kind: "temporary" | "quota";
  retryAtMs?: number;
}

export function parseResetTime(value: unknown, now = Date.now()): number | undefined {
  let ms: number;
  if (typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    ms = n < 100_000_000_000 ? n * 1000 : n;
  } else if (typeof value === "string" && (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) || /GMT$/i.test(value))) {
    ms = Date.parse(value);
  } else return undefined;
  return Number.isFinite(ms) && ms > now && ms <= now + 366 * 86_400_000 ? ms : undefined;
}

export function retryAtFromUpstream(value: unknown, now = Date.now()): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidates: number[] = [];
  for (const key of ["reset_at", "resets_at", "resetAt", "retry_at", "retryAt", "resetAtMs", "retryAtMs", "x-ratelimit-reset"]) {
    const parsed = parseResetTime(record[key], now);
    if (parsed) candidates.push(parsed);
  }
  for (const key of ["retry_after", "retryAfter", "retry_after_seconds", "retry-after"]) {
    const v = record[key];
    if ((typeof v === "number" || typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim())) && Number(v) >= 0 && Number(v) <= 366 * 86400) {
      candidates.push(now + Math.max(1000, Number(v) * 1000));
    } else {
      const parsed = parseResetTime(v, now);
      if (parsed) candidates.push(parsed);
    }
  }
  const milliseconds = record.retry_after_ms;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 366 * 86_400_000) candidates.push(now + Math.max(1000, milliseconds));
  for (const key of ["details", "error", "headers"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && nested !== value) {
      const fields = nested as Record<string, unknown>;
      // Flatten only known fields, so cyclic or deeply nested SDK objects are never traversed.
      const parsed = retryAtFromUpstream(Object.fromEntries(Object.entries(fields).filter(([k]) => !["details", "error", "headers"].includes(k))), now);
      if (parsed) candidates.push(parsed);
    }
  }
  const message = [record.message, record.error].filter((x): x is string => typeof x === "string").join(" ");
  const relative = /(?:retry|try again|resets?)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i.exec(message);
  if (relative) {
    const unit = relative[2]!.toLowerCase();
    const duration = Number(relative[1]) * (/^(hour|hr)/.test(unit) ? 3600000 : /^(minute|min)/.test(unit) ? 60000 : 1000);
    if (duration <= 366 * 86_400_000) candidates.push(now + Math.max(1000, duration));
  }
  const absolute = /(?:reset(?:s)?(?:_at)?|retry(?:_at)?|available)\s*(?:at|on|[:=])\s*(\d{4}-\d\d-\d\dT[^\s,;]+|\d{10,13})/i.exec(message);
  if (absolute) {
    const parsed = parseResetTime(absolute[1], now);
    if (parsed) candidates.push(parsed);
  }
  return candidates.length ? Math.max(...candidates) : undefined;
}

export function classifyAccountLimit(error: GatewayError): AccountLimit | undefined {
  if (["content_filter", "invalid_tool_call", "model_not_available", "invalid_request_error"].includes(error.code) || error.status === 401 || error.status === 403) return undefined;
  const message = `${error.code} ${error.message}`.toLowerCase();
  const retryAtMs = error.upstreamRetryAtMs ?? retryAtFromUpstream({ message: error.message });
  const quota = error.code !== "usage_limit_reached" && (error.status === 402 || /insufficient_quota|quota_exhausted|out of credits|credits? exhausted|monthly.{0,30}(?:limit|quota).{0,20}(?:reached|exceeded|exhausted)|billing limit|payment required|spend limit/.test(message));
  if (quota) return { kind: "quota", ...(retryAtMs ? { retryAtMs } : {}) };
  if (error.status === 429 || /usage.?limit|rate.?limit|too many requests|throttl|concurrency.{0,20}(?:limit|exceeded)/.test(message)) return { kind: "temporary", ...(retryAtMs ? { retryAtMs } : {}) };
  return undefined;
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccountCooldownState, AutoDisabledState, GatewayConfig, LbStrategy } from "./types.js";

export function loadDotEnv(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    process.env.ENV_FILE_PATH?.trim(),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "data", ".env")
  ].filter((p): p is string => Boolean(p));

  const envPath = candidates.find((p) => existsSync(p));
  if (!envPath) return undefined;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return envPath;
}

function parseIntEnv(val: string | undefined, fallback: number): number {
  if (val === undefined || val === "") return fallback;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parsePositiveMap(raw: string | undefined): Record<string, number> {
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, n]) => !["__proto__", "constructor", "prototype"].includes(key) && typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100).map(([key, n]) => [key, n as number]));
  } catch { return {}; }
}

function parseBoolEnv(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === "") return fallback;
  const v = val.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKeyAutoDisabled(raw: string | undefined): Record<string, AutoDisabledState> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AutoDisabledState> = Object.create(null);
    for (const [slot, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || slot === "__proto__" || slot === "constructor" || slot === "prototype") continue;
      const r = v as Record<string, unknown>;
      if (r.kind !== "quota" && r.kind !== "auth") continue;
      out[slot] = {
        kind: r.kind,
        reason: typeof r.reason === "string" ? r.reason.slice(0, 120) : "",
        ...(typeof r.resetAtMs === "number" && Number.isFinite(r.resetAtMs) ? { resetAtMs: r.resetAtMs } : {})
      };
    }
    return out;
  } catch {
    return {};
  }
}

function parseKeyCooldowns(raw: string | undefined): Record<string, AccountCooldownState> {
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, v]) => !["__proto__", "constructor", "prototype"].includes(key) &&
      v && typeof v === "object" && typeof (v as AccountCooldownState).untilMs === "number" && Number.isFinite((v as AccountCooldownState).untilMs))
      .map(([key, v]) => [key, { untilMs: (v as AccountCooldownState).untilMs, reason: typeof (v as AccountCooldownState).reason === "string" ? (v as AccountCooldownState).reason.slice(0, 160) : "Temporary usage limit" }]));
  } catch { return {}; }
}

function parseKeyLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        if (typeof v === "string" && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

function parseKeyAddedAt(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
      }
      return out;
    }
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

function parseTrustProxy(raw: string | undefined): "loopback" | "all" | "off" {
  const s = (raw || "").trim().toLowerCase();
  if (s === "all" || s === "true" || s === "1") return "all";
  if (s === "off" || s === "false" || s === "0") return "off";
  return "loopback";
}

function parseLbStrategy(raw: string | undefined): LbStrategy {
  const s = (raw || "").trim().toLowerCase();
  if (s === "round-robin" || s === "least-busy" || s === "quota-aware") return s;
  return "quota-aware";
}

export function normalizeDashboardPath(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "/dashboard";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const cleaned = withSlash.replace(/\/+$/, "");
  if (!cleaned || cleaned === "/" || cleaned.startsWith("/v1")) {
    return "/dashboard";
  }
  return cleaned;
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath?: string
): GatewayConfig {
  const settingsPath = envFilePath || env.ENV_FILE_PATH?.trim();
  // Console changes must survive a restart with Docker's original env_file snapshot.
  const persistedNames = new Set(["QUICK_TOKENS", "DISABLED_QUICK_TOKENS", "KEY_LABELS", "KEY_PROXIES", "KEY_ADDED_AT", "KEY_AUTO_DISABLED", "KEY_COOLDOWNS", "TEMPORARY_LIMIT_COOLDOWN_SECONDS",
    "LB_STRATEGY", "ACCOUNT_MAX_CONCURRENT", "KEY_CONCURRENCY_LIMITS", "KEY_WEIGHTS", "SESSION_AFFINITY_ENABLED", "SESSION_AFFINITY_TTL_MS",
    "AUTO_DISABLE_EXHAUSTED_KEYS", "INCOGNITO", "SHOW_THINKING_CONTENT", "DISABLED_MODELS", "ADMIN_PASSWORD"]);
  if (settingsPath && existsSync(settingsPath)) {
    env = { ...env };
    for (const line of readFileSync(settingsPath, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z_]+)\s*=(.*)$/.exec(line);
      if (match && persistedNames.has(match[1]!)) env[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  const gatewayTokens = new Set([
    ...splitCsv(env.GATEWAY_TOKEN),
    ...splitCsv(env.GATEWAY_TOKENS)
  ]);

  const quickTokens = Array.from(
    new Set([
      ...splitCsv(env.QUICK_TOKENS),
      ...splitCsv(env.QUICK_TOKEN)
    ])
  );

  const disabledQuickTokens = Array.from(new Set(splitCsv(env.DISABLED_QUICK_TOKENS)));
  if (process.platform === "darwin" && quickTokens.length === 0 && disabledQuickTokens.length === 0) {
    quickTokens.push("local-outpost");
  }
  const disabledModels = Array.from(new Set(splitCsv(env.DISABLED_MODELS)));
  const adminPassword = env.ADMIN_PASSWORD?.trim() || undefined;
  const enableDashboard = parseBoolEnv(env.ENABLE_DASHBOARD, true);
  const dashboardPath = normalizeDashboardPath(env.DASHBOARD_PATH);

  const explicitDataDir = env.DATA_DIR?.trim() || undefined;
  const resolvedDataDir =
    explicitDataDir ??
    (envFilePath
      ? path.dirname(envFilePath)
      : env.ENV_FILE_PATH?.trim()
        ? path.dirname(env.ENV_FILE_PATH.trim())
        : existsSync(path.resolve(process.cwd(), "data"))
          ? path.resolve(process.cwd(), "data")
          : undefined);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: parseIntEnv(env.PORT, 3456) || 3456,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    gatewayTokens,
    adminPassword,
    enableDashboard,
    showThinkingContent: parseBoolEnv(env.SHOW_THINKING_CONTENT, false),
    dashboardPath,
    quickTokens,
    disabledQuickTokens,
    disabledModels,
    keyLabels: parseKeyLabels(env.KEY_LABELS),
    keyProxies: parseKeyLabels(env.KEY_PROXIES),
    keyAddedAt: parseKeyAddedAt(env.KEY_ADDED_AT),
    keyAutoDisabled: parseKeyAutoDisabled(env.KEY_AUTO_DISABLED),
    keyCooldowns: parseKeyCooldowns(env.KEY_COOLDOWNS),
    temporaryLimitCooldownSeconds: Math.min(86400, Math.max(1, parseIntEnv(env.TEMPORARY_LIMIT_COOLDOWN_SECONDS, 300))),
    lbStrategy: parseLbStrategy(env.LB_STRATEGY),
    sessionAffinityEnabled: parseBoolEnv(env.SESSION_AFFINITY_ENABLED, true),
    sessionAffinityTtlMs: parseIntEnv(env.SESSION_AFFINITY_TTL_MS, 60 * 60 * 1000) || 60 * 60 * 1000,
    autoDisableExhaustedKeys: parseBoolEnv(env.AUTO_DISABLE_EXHAUSTED_KEYS, true),
    incognitoMode: parseBoolEnv(env.INCOGNITO, true),
    envFilePath,
    dataDir: resolvedDataDir,
    usageLedgerFile: env.USAGE_LEDGER_FILE?.trim() || (resolvedDataDir ? path.join(resolvedDataDir, "usage-ledger.json") : undefined),
    recordClientIp: parseBoolEnv(env.RECORD_CLIENT_IP, true),
    runIdleTimeoutMs: parseIntEnv(env.RUN_IDLE_TIMEOUT_MS, 10 * 60 * 1000) || 600_000,
    runMaxTimeoutMs: parseIntEnv(env.RUN_MAX_TIMEOUT_MS, 15 * 60 * 1000) || 900_000,
    warmSessionTtlMs: parseIntEnv(env.WARM_SESSION_TTL_MS, 30 * 60 * 1000) || 1_800_000,
    maxWarmSessions: Math.max(1, parseIntEnv(env.MAX_WARM_SESSIONS, 256)),
    keyCooldownMs: parseIntEnv(env.KEY_COOLDOWN_MS, 30 * 1000) || 30_000,
    clientKeyMaxConcurrent: Math.max(0, parseIntEnv(env.CLIENT_KEY_MAX_CONCURRENT, 0)),
    globalMaxConcurrent: Math.max(1, parseIntEnv(env.GLOBAL_MAX_CONCURRENT, 20)),
    maxQueuedRequests: parseIntEnv(env.MAX_QUEUED_REQUESTS, 200),
    queueWaitTimeoutMs: Math.max(1, parseIntEnv(env.QUEUE_WAIT_TIMEOUT_MS, 30000)),
    accountMaxConcurrent: Math.max(1, parseIntEnv(env.ACCOUNT_MAX_CONCURRENT, 2)),
    keyConcurrencyLimits: parsePositiveMap(env.KEY_CONCURRENCY_LIMITS),
    keyWeights: parsePositiveMap(env.KEY_WEIGHTS),
    maxBodyBytes: parseIntEnv(env.MAX_BODY_BYTES, 16 * 1024 * 1024) || 16_777_216
  };
}

function stripEnvNewlines(val: string): string {
  return val.replace(/[\r\n]/g, "");
}

function writeEnvFileAtomic(envFilePath: string, content: string): void {
  const dir = path.dirname(envFilePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${envFilePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on platforms/filesystems without POSIX chmod
  }
  try {
    renameSync(tmpPath, envFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EXDEV" || code === "EPERM") {
      writeFileSync(envFilePath, content, { mode: 0o600 });
      try {
        chmodSync(envFilePath, 0o600);
      } catch {
        // Ignore
      }
      return;
    }
    throw err;
  }
}

export function persistPoolConfigToEnvFile(
  envFilePath: string | undefined,
  state: {
    activeKeys: string[];
    disabledKeys: string[];
    keyLabels: Record<string, string>;
    keyProxies?: Record<string, string>;
    keyAddedAt?: Record<string, number>;
    keyAutoDisabled: Record<string, AutoDisabledState>;
    keyCooldowns?: Record<string, AccountCooldownState>;
    temporaryLimitCooldownSeconds?: number;
    lbStrategy: LbStrategy;
    sessionAffinityEnabled: boolean;
    sessionAffinityTtlMs: number;
    autoDisableExhaustedKeys: boolean;
    incognitoMode?: boolean;
    accountMaxConcurrent?: number;
    keyConcurrencyLimits?: Record<string, number>;
    keyWeights?: Record<string, number>;
  }
): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  const content = readFileSync(envFilePath, "utf8");
  const updates: Record<string, string> = {
    QUICK_TOKENS: stripEnvNewlines(state.activeKeys.join(",")),
    DISABLED_QUICK_TOKENS: stripEnvNewlines(state.disabledKeys.join(",")),
    KEY_LABELS: stripEnvNewlines(JSON.stringify(state.keyLabels)),
    ...(state.keyProxies ? { KEY_PROXIES: stripEnvNewlines(JSON.stringify(state.keyProxies)) } : {}),
    ...(state.keyAddedAt ? { KEY_ADDED_AT: stripEnvNewlines(JSON.stringify(state.keyAddedAt)) } : {}),
    KEY_AUTO_DISABLED: stripEnvNewlines(JSON.stringify(state.keyAutoDisabled)),
    ...(state.keyCooldowns ? { KEY_COOLDOWNS: JSON.stringify(state.keyCooldowns) } : {}),
    ...(state.temporaryLimitCooldownSeconds !== undefined ? { TEMPORARY_LIMIT_COOLDOWN_SECONDS: String(state.temporaryLimitCooldownSeconds) } : {}),
    LB_STRATEGY: state.lbStrategy,
    ...(state.accountMaxConcurrent ? { ACCOUNT_MAX_CONCURRENT: String(state.accountMaxConcurrent) } : {}),
    ...(state.keyConcurrencyLimits ? { KEY_CONCURRENCY_LIMITS: JSON.stringify(state.keyConcurrencyLimits) } : {}),
    ...(state.keyWeights ? { KEY_WEIGHTS: JSON.stringify(state.keyWeights) } : {}),
    SESSION_AFFINITY_ENABLED: String(state.sessionAffinityEnabled),
    SESSION_AFFINITY_TTL_MS: String(state.sessionAffinityTtlMs),
    AUTO_DISABLE_EXHAUSTED_KEYS: String(state.autoDisableExhaustedKeys),
    ...(typeof state.incognitoMode === "boolean"
      ? { INCOGNITO: String(state.incognitoMode) }
      : {})
  };
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key === "QUICK_TOKEN") return "";
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }

  const cleaned = lines.filter((l, idx, arr) => !(l === "" && arr[idx - 1] === "")).join("\n").trimEnd() + "\n";
  // Atomic replace: a crash mid-write must never leave a truncated .env (it holds the upstream keys).
  writeEnvFileAtomic(envFilePath, cleaned);
}

export function persistAdminPasswordToEnvFile(envFilePath: string | undefined, newPassword: string): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  if (/[\r\n]/.test(newPassword)) {
    throw new Error("Admin password must not contain newline characters.");
  }
  const content = readFileSync(envFilePath, "utf8");
  let found = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("ADMIN_PASSWORD=")) {
      found = true;
      return `ADMIN_PASSWORD=${newPassword}`;
    }
    return line;
  });
  if (!found) lines.push(`ADMIN_PASSWORD=${newPassword}`);
  writeEnvFileAtomic(envFilePath, lines.join("\n").trimEnd() + "\n");
}

export function persistThinkingDisplayToEnvFile(envFilePath: string | undefined, enabled: boolean): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  const content = readFileSync(envFilePath, "utf8");
  let found = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (/^\s*SHOW_THINKING_CONTENT\s*=/.test(line)) {
      found = true;
      return `SHOW_THINKING_CONTENT=${enabled}`;
    }
    return line;
  });
  if (!found) lines.push(`SHOW_THINKING_CONTENT=${enabled}`);
  writeEnvFileAtomic(envFilePath, lines.join("\n").trimEnd() + "\n");
}

export function persistDisabledModelsToEnvFile(envFilePath: string | undefined, disabledModels: string[]): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  const content = readFileSync(envFilePath, "utf8");
  const serialized = stripEnvNewlines(disabledModels.join(","));
  let found = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("DISABLED_MODELS=")) {
      found = true;
      return `DISABLED_MODELS=${serialized}`;
    }
    return line;
  });
  if (!found) lines.push(`DISABLED_MODELS=${serialized}`);
  writeEnvFileAtomic(envFilePath, lines.join("\n").trimEnd() + "\n");
}

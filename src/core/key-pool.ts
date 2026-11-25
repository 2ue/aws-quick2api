import { registerOAuthTokenSink, type RefreshedOAuthTokens } from "../aws-quick/oauth-token-store.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseOAuthCredential, serializeOAuthCredential } from "../aws-quick/oauth-client.js";
import { parseWebCurlOrCredential, serializeWebCredential } from "../aws-quick/web-client.js";
import type { BotQuotaView, QuickPlanQuotaView } from "../services/quota-service.js";
import { evictQuotaCachesForKey } from "../services/quota-service.js";
import { normalizeBaseModelId, redactSecrets } from "../utils/hash.js";
import { maskProxyUrl, validateProxyUrl } from "../utils/proxy-agent.js";
import { persistPoolConfigToEnvFile } from "./config.js";
import { SessionAffinityTable, type AffinityBindingView } from "./session-affinity.js";
import { GatewayError, type AccountCooldownState, type AutoDisabledState, type GatewayConfig, type LbStrategy } from "./types.js";
import { classifyAccountLimit, parseResetTime } from "./limit-policy.js";

export interface KeyIdentitySummary {
  apiKeyName: string;
  userEmail?: string;
  displayName?: string;
  userId?: number;
  createdAt: string;
}

export type KeyAuthType = "oauth" | "cookie" | "outpost";

export function detectKeyAuthType(rawKey: string): KeyAuthType {
  const s = rawKey.trim();
  if (s.startsWith("oauth:")) return "oauth";
  if (s.startsWith("web:")) return "cookie";
  return "outpost";
}

export interface KeySlotStatus {
  slotId: string;
  label?: string;
  authType: KeyAuthType;
  addedAt: number;
  maskedKey: string;
  maskedProxy?: string;
  enabled: boolean;
  healthy: boolean;
  autoDisabledReason?: string;
  autoDisabledKind?: "quota" | "auth";
  /** ISO time the gateway expects to re-enable this key by itself (quota trips only). */
  autoRecoverAt?: string;
  apiPoolExhausted: boolean;
  autoPoolExhausted: boolean;
  activeInflight: number;
  maxConcurrent: number;
  weight: number;
  stickySessions: number;
  cooldownRemainingMs: number;
  cooldownUntil?: string;
  cooldownReason?: string;
  totalSelected: number;
  affinityHits: number;
  rateLimitHits: number;
  quotaExhaustedHits: number;
  authErrors: number;
  identity?: KeyIdentitySummary;
  quota?: QuickPlanQuotaView;
  bot?: BotQuotaView;
  cloudSessionCount?: number | null;
  tokenRemainingSec?: number | null;
  lastSyncError?: string;
  quotaUpdatedAt?: string;
}

interface InternalKeySlot {
  quotaRevision: number;
  slotId: string;
  label?: string;
  authType: KeyAuthType;
  addedAt: number;
  rawKey: string;
  maskedKey: string;
  proxyUrl?: string;
  enabled: boolean;
  autoDisabledReason?: string;
  autoDisabledKind?: "quota" | "auth";
  autoResetAtMs?: number;
  apiPoolExhausted: boolean;
  autoPoolExhausted: boolean;
  activeInflight: number;
  maxConcurrent: number;
  weight: number;
  cooldownUntil: number;
  cooldownReason?: string;
  consecutiveRateLimits: number;
  selected: number;
  affinityHits: number;
  rateLimits: number;
  quotaExhaustedHits: number;
  authErrors: number;
  identity?: KeyIdentitySummary;
  quota?: QuickPlanQuotaView;
  bot?: BotQuotaView;
  cloudSessionCount?: number | null;
  tokenRemainingSec?: number | null;
  lastSyncError?: string;
  quotaUpdatedAt?: string;
}

export interface KeyLease {
  apiKey: string;
  slotId: string;
  maskedKey: string;
  label?: string;
  proxyUrl?: string;
  viaAffinity: boolean;
  markSuccess: () => void;
  release: () => void;
}

export interface PoolRoutingSettings {
  lbStrategy: LbStrategy;
  sessionAffinityEnabled: boolean;
  sessionAffinityTtlSeconds: number;
  autoDisableExhaustedKeys: boolean;
  incognitoMode: boolean;
  accountMaxConcurrent?: number;
  temporaryLimitCooldownSeconds?: number;
}

export function maskSecretKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export function computeKeySlotId(key: string): string {
  const oauth = parseOAuthCredential(key);
  const identity = oauth ? `oauth:${oauth.wsHost}:${oauth.clientId}` : key;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 10);
}

export function classifyModelQuotaPool(_requestedModel: string): "auto" | "api" {
  // Every registered alias is a Quick agent mode and consumes the Quick allowance.
  return "auto";
}

/**
 * Detect whether an upstream SDK / HTTP error means the account has run out of quota/money
 * (as opposed to a transient per-minute concurrency burst).
 */
export function isQuotaOrBillingExhaustedError(err: GatewayError): boolean {
  return classifyAccountLimit(err)?.kind === "quota";
}

function getRemainingPercentForPool(quota: QuickPlanQuotaView | undefined, pool: "auto" | "api"): number | null {
  if (!quota) return null;
  const target = pool === "auto"
    ? quota.sessionPool.remainingPercent
    : quota.premiumApiPool.remainingPercent;
  if (target !== null) return target;
  return quota.overallIncludedPlan.remainingPercent;
}

export class UpstreamKeyPool {
  private readonly slots: InternalKeySlot[] = [];
  private readonly baseCooldownMs: number;
  private readonly envFilePath?: string;
  private readonly identityFilePath?: string;
  private readonly savedIdentities: Record<string, { userEmail?: string; displayName?: string }> = Object.create(null);
  readonly affinityTable = new SessionAffinityTable();

  private lbStrategy: LbStrategy;
  private sessionAffinityEnabled: boolean;
  private sessionAffinityTtlMs: number;
  private autoDisableExhaustedKeys: boolean;
  private incognitoMode: boolean;
  private rrIndex = 0;
  private accountMaxConcurrent: number;
  private temporaryLimitCooldownSeconds: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly capacityWaiters = new Set<() => void>();
  private closed = false;
  private readonly stopTokenSink: () => void;

  constructor(config: Pick<
    GatewayConfig,
    | "quickTokens"
    | "disabledQuickTokens"
    | "keyLabels"
    | "keyProxies"
    | "keyAddedAt"
    | "keyAutoDisabled"
    | "keyCooldowns"
    | "temporaryLimitCooldownSeconds"
    | "keyCooldownMs"
    | "lbStrategy"
    | "sessionAffinityEnabled"
    | "sessionAffinityTtlMs"
    | "autoDisableExhaustedKeys"
    | "incognitoMode"
    | "envFilePath"
    | "dataDir"
    | "accountMaxConcurrent"
    | "keyConcurrencyLimits"
    | "keyWeights"
    | "queueWaitTimeoutMs"
  >) {
    this.baseCooldownMs = config.keyCooldownMs;
    this.temporaryLimitCooldownSeconds = config.temporaryLimitCooldownSeconds ?? 300;
    this.accountMaxConcurrent = config.accountMaxConcurrent ?? 2;
    this.queueWaitTimeoutMs = config.queueWaitTimeoutMs ?? 30000;
    this.lbStrategy = config.lbStrategy;
    this.sessionAffinityEnabled = config.sessionAffinityEnabled;
    this.sessionAffinityTtlMs = config.sessionAffinityTtlMs;
    this.autoDisableExhaustedKeys = config.autoDisableExhaustedKeys;
    this.incognitoMode = config.incognitoMode !== false;
    this.envFilePath = config.envFilePath;
    this.stopTokenSink = registerOAuthTokenSink((tokens) => this.saveOAuthTokens(tokens));
    if (config.dataDir) {
      this.identityFilePath = path.join(config.dataDir, "account-identities.json");
      this.loadSavedIdentities();
    }

    const bootNow = Date.now();
    const totalBootKeys = config.quickTokens.length + config.disabledQuickTokens.length;
    let bootIdx = 0;
    for (const k of config.quickTokens) {
      const s = this.upsertInternal(k, true);
      const oldId = crypto.createHash("sha256").update(k).digest("hex").slice(0, 10);
      const configId: string = config.keyLabels[s.slotId] !== undefined || config.keyProxies?.[s.slotId] !== undefined || config.keyAddedAt?.[s.slotId] !== undefined ? s.slotId : oldId;
      if (config.keyLabels[configId]) s.label = config.keyLabels[configId];
      if (config.keyProxies?.[configId]) s.proxyUrl = config.keyProxies[configId];
      s.addedAt = config.keyAddedAt?.[configId] ?? (bootNow - (totalBootKeys - bootIdx) * 1000);
      s.maxConcurrent = config.keyConcurrencyLimits?.[s.slotId] ?? this.accountMaxConcurrent;
      s.weight = config.keyWeights?.[s.slotId] ?? 1;
      bootIdx += 1;
    }
    for (const k of config.disabledQuickTokens) {
      if (!this.slots.some((s) => s.rawKey === k)) {
        const s = this.upsertInternal(k, false);
        const oldId = crypto.createHash("sha256").update(k).digest("hex").slice(0, 10);
        const configId: string = config.keyLabels[s.slotId] !== undefined || config.keyProxies?.[s.slotId] !== undefined || config.keyAddedAt?.[s.slotId] !== undefined ? s.slotId : oldId;
        if (config.keyLabels[configId]) s.label = config.keyLabels[configId];
        if (config.keyProxies?.[configId]) s.proxyUrl = config.keyProxies[configId];
        s.addedAt = config.keyAddedAt?.[configId] ?? (bootNow - (totalBootKeys - bootIdx) * 1000);
        s.maxConcurrent = config.keyConcurrencyLimits?.[s.slotId] ?? this.accountMaxConcurrent;
        s.weight = config.keyWeights?.[s.slotId] ?? 1;
        bootIdx += 1;
        const saved = config.keyAutoDisabled?.[configId];
        if (saved) {
          s.autoDisabledKind = saved.kind;
          s.autoDisabledReason = saved.reason || undefined;
          if (saved.resetAtMs) s.autoResetAtMs = saved.resetAtMs;
        }
      }
    }
    let migrated = false;
    for (const slot of this.slots) {
      const automatic = config.keyAutoDisabled?.[slot.slotId];
      if (automatic && slot.enabled) {
        slot.autoDisabledKind = automatic.kind;
        slot.autoDisabledReason = automatic.reason;
        slot.autoResetAtMs = automatic.resetAtMs;
        if (automatic.kind === "quota") slot.autoPoolExhausted = true;
      }
      const saved = config.keyCooldowns?.[slot.slotId];
      if (saved && saved.untilMs > bootNow) {
        slot.cooldownUntil = saved.untilMs;
        slot.cooldownReason = saved.reason;
      }
      // Earlier versions treated the generic platform usage-limit reply as permanent quota exhaustion.
      if (slot.autoDisabledKind === "quota" && (slot.autoDisabledReason?.startsWith("Auto-disabled (quota exhausted): AWS Quick account reached its") || slot.autoDisabledReason === "Auto-disabled: Session burst pool reached 0%")) {
        slot.enabled = true;
        slot.autoDisabledKind = undefined;
        slot.autoDisabledReason = undefined;
        slot.autoResetAtMs = undefined;
        slot.autoPoolExhausted = false;
        slot.apiPoolExhausted = false;
        slot.cooldownUntil = bootNow + this.temporaryLimitCooldownSeconds * 1000;
        slot.cooldownReason = "Temporary usage limit (migrated from earlier classification)";
        migrated = true;
      }
    }
    if (migrated) this.persist();
  }

  private upsertInternal(rawKey: string, enabled: boolean, label?: string): InternalKeySlot {
    const trimmed = rawKey.trim();
    const existing = this.slots.find((s) => s.slotId === computeKeySlotId(trimmed));
    if (existing) {
      existing.quotaRevision++;
      existing.rawKey = trimmed;
      existing.maskedKey = maskSecretKey(trimmed);
      this.affinityTable.replaceCredential(existing.slotId, trimmed, existing.maskedKey);
      existing.enabled = enabled;
      if (enabled) {
        existing.autoDisabledReason = undefined;
        existing.autoDisabledKind = undefined;
      }
      if (label !== undefined) existing.label = label.trim() || undefined;
      return existing;
    }
    const slotId = computeKeySlotId(trimmed);
    const authType = detectKeyAuthType(trimmed);
    let initialIdentity: KeyIdentitySummary | undefined;
    const savedId = this.savedIdentities[slotId] ?? this.savedIdentities[crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 10)];
    if (authType === "oauth") {
      const parsedOAuth = parseOAuthCredential(trimmed);
      if (parsedOAuth?.email || parsedOAuth?.name || savedId?.userEmail || savedId?.displayName) {
        initialIdentity = {
          apiKeyName: "oauth-pkce (90d)",
          ...(parsedOAuth?.email || savedId?.userEmail ? { userEmail: parsedOAuth?.email || savedId?.userEmail } : {}),
          ...(parsedOAuth?.name || savedId?.displayName ? { displayName: parsedOAuth?.name || savedId?.displayName } : {}),
          createdAt: new Date().toISOString(),
        };
      }
    } else if (savedId?.userEmail || savedId?.displayName) {
      initialIdentity = {
        apiKeyName: authType === "cookie" ? "web-cookie" : "local-outpost",
        ...(savedId.userEmail ? { userEmail: savedId.userEmail } : {}),
        ...(savedId.displayName ? { displayName: savedId.displayName } : {}),
        createdAt: new Date().toISOString(),
      };
    }
    const slot: InternalKeySlot = {
      slotId,
      ...(label?.trim() ? { label: label.trim() } : {}),
      authType,
      addedAt: Date.now(),
      rawKey: trimmed,
      maskedKey: maskSecretKey(trimmed),
      enabled,
      apiPoolExhausted: false,
      autoPoolExhausted: false,
      activeInflight: 0,
      maxConcurrent: this.accountMaxConcurrent,
      weight: 1,
      cooldownUntil: 0,
      consecutiveRateLimits: 0,
      selected: 0,
      affinityHits: 0,
      rateLimits: 0,
      quotaExhaustedHits: 0,
      authErrors: 0,
      quotaRevision: 0,
      ...(initialIdentity ? { identity: initialIdentity } : {}),
    };
    this.slots.push(slot);
    return slot;
  }

  private loadSavedIdentities(): void {
    if (!this.identityFilePath) return;
    try {
      const raw = fs.readFileSync(this.identityFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          if (v && typeof v === "object") {
            const rec = v as Record<string, unknown>;
            this.savedIdentities[k] = {
              ...(typeof rec.userEmail === "string" && rec.userEmail.trim() ? { userEmail: rec.userEmail.trim() } : {}),
              ...(typeof rec.displayName === "string" && rec.displayName.trim() ? { displayName: rec.displayName.trim() } : {}),
            };
          }
        }
      }
    } catch {
      // File may not exist on first boot
    }
  }

  private persistSavedIdentities(): void {
    if (!this.identityFilePath) return;
    try {
      const dir = path.dirname(this.identityFilePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.identityFilePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.savedIdentities, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.identityFilePath);
    } catch {
      // Non-fatal persistence failure
    }
  }

  private persist(): void {
    const keyLabels: Record<string, string> = {};
    const keyProxies: Record<string, string> = {};
    const keyAddedAt: Record<string, number> = {};
    for (const s of this.slots) {
      if (s.label) keyLabels[s.slotId] = s.label;
      if (s.proxyUrl) keyProxies[s.slotId] = s.proxyUrl;
      if (s.addedAt) keyAddedAt[s.slotId] = s.addedAt;
    }
    const keyAutoDisabled: Record<string, AutoDisabledState> = {};
    const keyCooldowns: Record<string, AccountCooldownState> = {};
    for (const s of this.slots) {
      if (s.cooldownUntil > Date.now()) keyCooldowns[s.slotId] = { untilMs: s.cooldownUntil, reason: s.cooldownReason || "Temporary upstream failure" };
      if (s.autoDisabledKind && s.autoDisabledReason) {
        keyAutoDisabled[s.slotId] = {
          kind: s.autoDisabledKind,
          reason: s.autoDisabledReason,
          ...(s.autoResetAtMs ? { resetAtMs: s.autoResetAtMs } : {})
        };
      }
    }
    persistPoolConfigToEnvFile(this.envFilePath, {
      activeKeys: this.slots.filter((s) => s.enabled).map((s) => s.rawKey),
      disabledKeys: this.slots.filter((s) => !s.enabled).map((s) => s.rawKey),
      keyLabels,
      keyProxies,
      keyAddedAt,
      keyAutoDisabled,
      keyCooldowns,
      temporaryLimitCooldownSeconds: this.temporaryLimitCooldownSeconds,
      accountMaxConcurrent: this.accountMaxConcurrent,
      keyConcurrencyLimits: Object.fromEntries(this.slots.map((s) => [s.slotId, s.maxConcurrent])),
      keyWeights: Object.fromEntries(this.slots.map((s) => [s.slotId, s.weight])),
      lbStrategy: this.lbStrategy,
      sessionAffinityEnabled: this.sessionAffinityEnabled,
      sessionAffinityTtlMs: this.sessionAffinityTtlMs,
      autoDisableExhaustedKeys: this.autoDisableExhaustedKeys,
      incognitoMode: this.incognitoMode
    });
  }

  getSettings(): PoolRoutingSettings {
    return {
      lbStrategy: this.lbStrategy,
      sessionAffinityEnabled: this.sessionAffinityEnabled,
      sessionAffinityTtlSeconds: Math.round(this.sessionAffinityTtlMs / 1000),
      autoDisableExhaustedKeys: this.autoDisableExhaustedKeys,
      incognitoMode: this.incognitoMode,
      accountMaxConcurrent: this.accountMaxConcurrent,
      temporaryLimitCooldownSeconds: this.temporaryLimitCooldownSeconds
    };
  }

  updateSettings(patch: Partial<PoolRoutingSettings>): void {
    if (patch.temporaryLimitCooldownSeconds !== undefined && (!Number.isInteger(patch.temporaryLimitCooldownSeconds) || patch.temporaryLimitCooldownSeconds < 1 || patch.temporaryLimitCooldownSeconds > 86400)) {
      throw new GatewayError("Temporary cooldown must be an integer between 1 and 86400 seconds.", 400, "invalid_cooldown");
    }
    if (patch.accountMaxConcurrent !== undefined) {
      if (!Number.isInteger(patch.accountMaxConcurrent) || patch.accountMaxConcurrent < 1 || patch.accountMaxConcurrent > 100) throw new GatewayError("Account concurrency must be between 1 and 100.", 400, "invalid_concurrency");
      const previous = this.accountMaxConcurrent;
      this.accountMaxConcurrent = patch.accountMaxConcurrent;
      for (const slot of this.slots) if (slot.maxConcurrent === previous) slot.maxConcurrent = this.accountMaxConcurrent;
    }
    if (patch.lbStrategy) this.lbStrategy = patch.lbStrategy;
    if (patch.temporaryLimitCooldownSeconds !== undefined) this.temporaryLimitCooldownSeconds = patch.temporaryLimitCooldownSeconds;
    if (typeof patch.sessionAffinityEnabled === "boolean") {
      this.sessionAffinityEnabled = patch.sessionAffinityEnabled;
      if (!patch.sessionAffinityEnabled) this.affinityTable.clearAll();
    }
    if (typeof patch.sessionAffinityTtlSeconds === "number" && patch.sessionAffinityTtlSeconds >= 10) {
      this.sessionAffinityTtlMs = patch.sessionAffinityTtlSeconds * 1000;
    }
    if (typeof patch.autoDisableExhaustedKeys === "boolean") {
      this.autoDisableExhaustedKeys = patch.autoDisableExhaustedKeys;
    }
    if (typeof patch.incognitoMode === "boolean") {
      this.incognitoMode = patch.incognitoMode;
    }
    this.persist();
  }

  allManagedKeys(): Array<{ slotId: string; rawKey: string; enabled: boolean; label?: string; proxyUrl?: string }> {
    this.reviveCycleResetAccounts();
    return this.slots.map((s) => ({
      slotId: s.slotId,
      rawKey: s.rawKey,
      enabled: s.enabled,
      ...(s.label ? { label: s.label } : {}),
      ...(s.proxyUrl ? { proxyUrl: s.proxyUrl } : {}),
    }));
  }

  proxyUrlForKey(rawKey: string): string | undefined {
    return this.slots.find((s) => s.slotId === computeKeySlotId(rawKey))?.proxyUrl;
  }

  enabledKeyCount(): number {
    this.reviveCycleResetAccounts();
    return this.slots.filter((s) => s.enabled).length;
  }

  private reviveCycleResetAccounts(): void {
    const now = Date.now();
    let changed = false;
    for (const s of this.slots) {
      if (s.cooldownUntil > 0 && s.cooldownUntil <= now) {
        s.cooldownUntil = 0;
        s.cooldownReason = undefined;
        if (s.quota?.sessionPool.remainingPercent === 0) s.quota.sessionPool.remainingPercent = null;
        changed = true;
      }
      // Only quota trips self-heal on the billing reset; an auth failure needs an explicit re-check.
      if (s.autoDisabledKind === "quota" && s.autoResetAtMs && now >= s.autoResetAtMs) {
        s.quotaRevision++;
        s.enabled = true;
        s.autoDisabledReason = undefined;
        s.autoDisabledKind = undefined;
        s.autoResetAtMs = undefined;
        s.apiPoolExhausted = false;
        s.autoPoolExhausted = false;
        s.quota = undefined;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private isSlotEligibleForPool(slot: InternalKeySlot, _targetPool: "auto" | "api", now: number): boolean {
    if (!slot.enabled) return false;
    if (slot.cooldownUntil > now) return false;
    const exhausted = _targetPool === "auto" ? slot.autoPoolExhausted : slot.apiPoolExhausted;
    if (exhausted && !slot.quota?.onDemandSpend.enabled) return false;
    return true;
  }

  isKeyUsable(rawKey: string, requestedModel = "auto"): boolean {
    this.reviveCycleResetAccounts();
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return true;
    const pool = classifyModelQuotaPool(requestedModel);
    return this.isSlotEligibleForPool(slot, pool, Date.now());
  }

  leaseSpecificKey(rawKey: string, viaAffinity = false): KeyLease {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (slot && slot.activeInflight >= slot.maxConcurrent) throw this.capacityError("Account is busy.");
    if (slot) {
      slot.selected += 1;
      if (viaAffinity) slot.affinityHits += 1;
      slot.activeInflight += 1;
    }
    let released = false;
    return {
      apiKey: rawKey,
      slotId: slot?.slotId ?? "direct",
      maskedKey: slot?.maskedKey ?? maskSecretKey(rawKey),
      ...(slot?.label ? { label: slot.label } : {}),
      ...(slot?.proxyUrl ? { proxyUrl: slot.proxyUrl } : {}),
      viaAffinity,
      markSuccess: () => {
        if (slot) slot.consecutiveRateLimits = 0;
      },
      release: () => {
        if (released) return;
        released = true;
        if (slot && slot.activeInflight > 0) slot.activeInflight -= 1;
        this.notifyCapacity();
      }
    };
  }

  /**
   * Read-only pick of one enabled upstream key for catalog lookups (`/v1/models`, admin model list).
   * Unlike `leaseKey` it does not count as a selection, bind affinity, occupy a concurrency slot,
   * or fail with a quota error just because the pool is busy.
   */
  peekKeyForCatalog(): string {
    this.reviveCycleResetAccounts();
    const slot = this.slots.find((x) => x.enabled);
    if (!slot) {
      throw new GatewayError("No enabled upstream AWS Quick credentials available.", 503, "no_enabled_keys");
    }
    return slot.rawKey;
  }

  /**
   * Lease an optimal upstream AWS Quick credential after client authentication has already succeeded.
   * Always selects from the managed pool (1h sticky affinity); caller tokens are never used upstream.
   */
  leaseKey(
    requestedModel = "auto",
    excludeKeys?: ReadonlySet<string>,
    conversationKey?: string
  ): KeyLease {
    this.reviveCycleResetAccounts();

    // Never use caller tokens upstream; always pick from the managed credential pool.
    if (this.slots.length === 0) {
      throw new GatewayError("All upstream AWS Quick accounts are currently disabled or unconfigured.", 503, "no_enabled_keys");
    }
    return this.pickFromPool(requestedModel, excludeKeys, conversationKey);
  }

  private capacityError(message: string): GatewayError {
    return Object.assign(new GatewayError(message, 429, "accounts_busy"), { retryAfter: 1 });
  }

  private notifyCapacity(): void {
    for (const wake of [...this.capacityWaiters]) wake();
  }

  async acquireKey(requestedModel = "auto", excludeKeys?: ReadonlySet<string>, conversationKey?: string, signal?: AbortSignal): Promise<KeyLease> {
    const deadline = Date.now() + this.queueWaitTimeoutMs;
    for (;;) {
      if (this.closed) throw new GatewayError("Account pool is shutting down.", 503, "gateway_closing");
      if (signal?.aborted) throw new GatewayError("Request canceled.", 499, "request_canceled");
      try { return this.leaseKey(requestedModel, excludeKeys, conversationKey); }
      catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "accounts_busy") throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw Object.assign(new GatewayError("Timed out waiting for an available account.", 429, "account_queue_timeout"), { retryAfter: (error as GatewayError & { retryAfter?: number }).retryAfter ?? 1 });
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(timer); this.capacityWaiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, Math.min(remaining, 500));
          this.capacityWaiters.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
          if (signal?.aborted) wake();
        });
      }
    }
  }

  private saveOAuthTokens(tokens: RefreshedOAuthTokens): void {
    const slot = this.slots.find((s) => {
      const credential = parseOAuthCredential(s.rawKey);
      return credential?.clientId === tokens.clientId && credential.wsHost === tokens.wsHost;
    });
    if (!slot) return;
    const credential = parseOAuthCredential(slot.rawKey)!;
    if (credential.accessToken === tokens.accessToken && credential.refreshToken === tokens.refreshToken && credential.expiresAt === tokens.expiresAt) return;
    const previous = slot.rawKey;
    slot.rawKey = serializeOAuthCredential({ ...credential, accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
    try { this.persist(); }
    catch {
      slot.rawKey = previous;
      throw new GatewayError("Could not persist refreshed account credentials.", 503, "credential_persistence_error");
    }
    slot.maskedKey = maskSecretKey(slot.rawKey);
    this.affinityTable.replaceCredential(slot.slotId, slot.rawKey, slot.maskedKey);
  }

  close(): void { this.closed = true; this.stopTokenSink(); this.notifyCapacity(); }

  private pickFromPool(
    requestedModel: string,
    excludeKeys?: ReadonlySet<string>,
    conversationKey?: string
  ): KeyLease {
    const now = Date.now();
    const targetPool = classifyModelQuotaPool(requestedModel);
    const excludedIds = new Set([...(excludeKeys ?? [])].map(computeKeySlotId));

    // Step 1: Check CPA-style Sticky Session Affinity first!
    if (this.sessionAffinityEnabled && conversationKey) {
      const stickyRawKey = this.affinityTable.lookup(conversationKey, this.sessionAffinityTtlMs);
      if (stickyRawKey && !excludedIds.has(computeKeySlotId(stickyRawKey))) {
        const stickySlot = this.slots.find((s) => s.rawKey === stickyRawKey);
        if (stickySlot && this.isSlotEligibleForPool(stickySlot, targetPool, now)) {
          if (stickySlot.activeInflight >= stickySlot.maxConcurrent) throw this.capacityError("Pinned account is busy.");
          return this.leaseSpecificKey(stickySlot.rawKey, true);
        }
        // Bound account is exhausted, cooling down, or disabled -> break affinity so we rebind cleanly to B!
        this.affinityTable.evictConversation(conversationKey);
      }
    }

    const enabledSlots = this.slots.filter((s) => s.enabled && !excludedIds.has(s.slotId));
    if (enabledSlots.length === 0) {
      throw new GatewayError("No enabled upstream AWS Quick credentials available.", 503, "no_enabled_keys");
    }

    let candidates = enabledSlots.filter((s) => this.isSlotEligibleForPool(s, targetPool, now));
    if (!candidates.length) {
      const cooling = enabledSlots.filter((s) => s.cooldownUntil > now);
      if (cooling.length) throw Object.assign(this.capacityError("All available accounts are cooling down."), { retryAfter: Math.max(1, Math.ceil((Math.min(...cooling.map((s) => s.cooldownUntil)) - now) / 1000)) });
      throw new GatewayError("All enabled AWS Quick accounts have exhausted their quota.", 429, "quota_exhausted");
    }
    candidates = candidates.filter((s) => s.activeInflight < s.maxConcurrent);
    if (!candidates.length) throw this.capacityError("All available accounts are busy.");

    if (this.lbStrategy === "round-robin") {
      const picked = this.nextRoundRobin(candidates);
      return this.bindAndLease(picked, conversationKey);
    }

    if (this.lbStrategy === "quota-aware") {
      const withIncluded = candidates.filter((s) => {
        const rem = getRemainingPercentForPool(s.quota, targetPool);
        const flagged = targetPool === "auto" ? s.autoPoolExhausted : s.apiPoolExhausted;
        return !flagged && (rem === null || rem > 0);
      });
      if (withIncluded.length > 0) candidates = withIncluded;
    }

    const n = this.slots.length;
    const startIdx = this.rrIndex;
    this.rrIndex = (this.rrIndex + 1) % Math.max(1, n);

    candidates.sort((a, b) => {
      const load = a.activeInflight / a.weight - b.activeInflight / b.weight;
      if (load !== 0) return load;
      if (this.lbStrategy === "quota-aware") {
        const remA = getRemainingPercentForPool(a.quota, targetPool);
        const remB = getRemainingPercentForPool(b.quota, targetPool);
        const bandA = remA !== null ? Math.floor(remA / 15) : 7;
        const bandB = remB !== null ? Math.floor(remB / 15) : 7;
        if (bandA !== bandB) return bandB - bandA;
      }
      const idxA = (this.slots.indexOf(a) - startIdx + n) % n;
      const idxB = (this.slots.indexOf(b) - startIdx + n) % n;
      return idxA - idxB;
    });

    return this.bindAndLease(candidates[0]!, conversationKey);
  }

  private bindAndLease(slot: InternalKeySlot, conversationKey?: string): KeyLease {
    if (this.sessionAffinityEnabled && conversationKey) {
      this.affinityTable.bind({
        conversationKey,
        rawKey: slot.rawKey,
        slotId: slot.slotId,
        maskedKey: slot.maskedKey,
        ttlMs: this.sessionAffinityTtlMs
      });
    }
    return this.leaseSpecificKey(slot.rawKey, false);
  }

  private nextRoundRobin(candidates: InternalKeySlot[]): InternalKeySlot {
    const n = this.slots.length;
    for (let offset = 0; offset < n; offset += 1) {
      const slot = this.slots[(this.rrIndex + offset) % n]!;
      if (candidates.includes(slot)) {
        this.rrIndex = (this.rrIndex + offset + 1) % n;
        return slot;
      }
    }
    return candidates[0]!;
  }

  /**
   * CPA-style exponential backoff cooldown for transient 429 burst errors (30s -> 60s -> 120s -> max 300s).
   */
  reportRateLimit(rawKey: string): void {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return;
    slot.rateLimits += 1;
    slot.consecutiveRateLimits += 1;
    const multiplier = Math.min(10, 2 ** (slot.consecutiveRateLimits - 1));
    const backoffMs = Math.min(300_000, this.baseCooldownMs * multiplier);
    slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + backoffMs);
    slot.cooldownReason = "Transient upstream connection failure";
    this.affinityTable.evictAllForKey(slot.rawKey);
    this.persist();
  }

  reportTemporaryLimit(rawKey: string, retryAtMs?: number, reason = "Temporary upstream usage limit"): void {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return;
    slot.rateLimits++;
    const now = Date.now();
    const until = retryAtMs && retryAtMs > now ? retryAtMs : now + this.temporaryLimitCooldownSeconds * 1000;
    slot.cooldownUntil = Math.max(slot.cooldownUntil, until);
    slot.cooldownReason = redactSecrets(reason).slice(0, 160);
    this.affinityTable.evictAllForKey(slot.rawKey);
    this.persist();
    this.notifyCapacity();
  }

  /**
   * Circuit breaker when an account runs out of money/quota mid-flight!
   * Evicts sticky sessions from Account A so they seamlessly rebind to Account B,
   * marks the affected pool exhausted, and auto-disables Account A if configured!
   */
  reportQuotaExhausted(rawKey: string, requestedModel: string, reasonDetail?: string, retryAtMs?: number): void {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return;
    slot.quotaExhaustedHits += 1;
    if (!slot.enabled && slot.autoDisabledKind !== "quota") return;
    slot.quotaRevision++;
    this.affinityTable.evictAllForKey(slot.rawKey);
    const now = Date.now();
    slot.autoResetAtMs = retryAtMs && retryAtMs > now ? retryAtMs : parseResetTime(slot.quota?.billingCycleEnd, now) ?? (slot.autoResetAtMs && slot.autoResetAtMs > now ? slot.autoResetAtMs : now + 3600000);
    slot.autoDisabledKind = "quota";
    slot.autoDisabledReason = reasonDetail ? `Auto-disabled (quota exhausted): ${redactSecrets(reasonDetail).slice(0, 120)}` : "Auto-disabled: quota exhausted";

    const pool = classifyModelQuotaPool(requestedModel);
    if (pool === "auto") {
      slot.autoPoolExhausted = true;
    } else {
      slot.apiPoolExhausted = true;
    }

    if (this.autoDisableExhaustedKeys) {
      const autoStillHasBalance = pool === "api"
        && !slot.autoPoolExhausted
        && (slot.quota?.sessionPool.remainingPercent ?? 0) > 0;

      if (!autoStillHasBalance) {
        slot.enabled = false;
        slot.autoDisabledKind = "quota";
        slot.autoDisabledReason = reasonDetail
          ? `Auto-disabled (quota exhausted): ${redactSecrets(reasonDetail).slice(0, 60)}`
          : "Auto-disabled: quota exhausted";
      }
    }
    this.persist();
    this.notifyCapacity();
  }

  reportAuthFailure(rawKey: string, reasonDetail?: string): void {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return;
    slot.quotaRevision++;
    slot.authErrors += 1;
    if (!slot.enabled && !slot.autoDisabledKind) return;
    this.affinityTable.evictAllForKey(slot.rawKey);
    slot.autoDisabledKind = "auth";
    slot.autoDisabledReason = reasonDetail ? `Auto-disabled (auth failed): ${redactSecrets(reasonDetail).slice(0, 60)}` : "Auto-disabled: authentication failed (401 Unauthorized)";
    slot.autoResetAtMs = undefined;

    if (this.autoDisableExhaustedKeys) {
      slot.enabled = false;
    } else {
      slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + this.baseCooldownMs * 10);
      slot.cooldownReason = "Authentication failed; awaiting credential retry";
    }
    this.persist();
  }

  /**
   * Update live quota telemetry from `/auth/usage-summary` and proactively trip/reset exhaustion flags!
   */
  updateSlotQuotaCache(
    rawKey: string,
    identity?: KeyIdentitySummary,
    quota?: QuickPlanQuotaView,
    bot?: BotQuotaView,
    extra?: { cloudSessionCount?: number | null; tokenRemainingSec?: number | null; syncError?: string | null },
  ): void {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot) return;
    if (extra?.syncError !== undefined) {
      slot.lastSyncError = extra.syncError ? extra.syncError.slice(0, 220) : undefined;
    }
    if (identity) {
      slot.identity = identity;
      const email = identity.userEmail && identity.userEmail.includes("@") ? identity.userEmail : undefined;
      const dname = identity.displayName || undefined;
      const prev = this.savedIdentities[slot.slotId];
      if ((email || dname) && (prev?.userEmail !== email || prev?.displayName !== dname)) {
        this.savedIdentities[slot.slotId] = {
          ...(email ? { userEmail: email } : prev?.userEmail ? { userEmail: prev.userEmail } : {}),
          ...(dname ? { displayName: dname } : prev?.displayName ? { displayName: prev.displayName } : {}),
        };
        this.persistSavedIdentities();
      }
    }
    if (extra?.cloudSessionCount !== undefined) slot.cloudSessionCount = extra.cloudSessionCount;
    if (extra?.tokenRemainingSec !== undefined) slot.tokenRemainingSec = extra.tokenRemainingSec;
    if (bot) slot.bot = bot;
    if (!quota) return;

    slot.quotaRevision++;

    slot.quota = quota;
    slot.quotaUpdatedAt = new Date().toISOString();

    const autoRem = quota.sessionPool.remainingPercent;
    const apiRem = quota.premiumApiPool.remainingPercent;
    // Monthly exhaustion is a hard quota; the shorter session window is a temporary cooldown.
    if (apiRem !== null) {
      slot.apiPoolExhausted = apiRem <= 0;
      slot.autoPoolExhausted = slot.apiPoolExhausted;
    }
    const managed = slot.enabled && slot.autoDisabledKind !== "auth" || slot.autoDisabledKind === "quota";
    if (!managed) return;
    if (slot.apiPoolExhausted) {
      this.reportQuotaExhausted(slot.rawKey, "auto", "Monthly quota exhausted", parseResetTime(quota.billingCycleEnd));
    } else {
      if (slot.autoDisabledKind === "quota" && apiRem !== null && autoRem !== null && autoRem > 0) {
        slot.enabled = true;
        slot.autoDisabledReason = undefined;
        slot.autoDisabledKind = undefined;
        slot.autoResetAtMs = undefined;
        this.persist();
      }
      if (slot.enabled && autoRem !== null && autoRem <= 0) {
        const resetAt = parseResetTime(quota.sessionPool.resetAt);
        if (slot.cooldownUntil <= Date.now() || resetAt && resetAt > slot.cooldownUntil) this.reportTemporaryLimit(slot.rawKey, resetAt, "Session usage window exhausted");
      }
    }
  }

  /** Capture identity and administrative state so late diagnostics cannot undo newer decisions. */
  createLimitQuotaUpdater(rawKey: string): ((quota?: QuickPlanQuotaView, error?: string) => void) | undefined {
    const slot = this.slots.find((s) => s.slotId === computeKeySlotId(rawKey));
    if (!slot || slot.autoDisabledKind === "auth" || !slot.enabled && slot.autoDisabledKind !== "quota") return undefined;
    const revision = slot.quotaRevision;
    return (quota, error) => {
      if (this.closed || !this.slots.includes(slot) || slot.quotaRevision !== revision) return;
      if (error) { slot.lastSyncError = redactSecrets(error).slice(0, 220);return; }
      if (!quota) return;
      slot.quota = quota;
      slot.quotaUpdatedAt = new Date().toISOString();
      slot.lastSyncError = undefined;
      slot.quotaRevision++;
      // Positive/unknown telemetry does not cancel an actual limit response or re-enable its account.
      if (quota.premiumApiPool.remainingPercent === 0) {
        slot.apiPoolExhausted = true;
        slot.autoPoolExhausted = true;
        this.reportQuotaExhausted(slot.rawKey, "auto", "Monthly quota exhausted (automatic usage check)", parseResetTime(quota.billingCycleEnd));
      } else if (slot.enabled && quota.sessionPool.remainingPercent === 0) {
        this.reportTemporaryLimit(slot.rawKey, parseResetTime(quota.sessionPool.resetAt), "Session usage window exhausted (automatic usage check)");
      }
    };
  }

  /** Quota-tripped keys that should be probed for recovery (disabled by the gateway, not by a person). */
  recoveryProbeKeys(): string[] {
    return this.slots.filter((s) => !s.enabled && s.autoDisabledKind === "quota").map((s) => s.rawKey);
  }

  /** Clear an automatic trip so the key is used again; the next request or sync re-trips it if still bad. */
  recheckSlot(slotId: string): void {
    const slot = this.slots.find((s) => s.slotId === slotId);
    if (!slot) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    slot.quotaRevision++;
    if (!slot.enabled && slot.autoDisabledKind) {
      slot.enabled = true;
      slot.autoDisabledReason = undefined;
      slot.autoDisabledKind = undefined;
      slot.autoResetAtMs = undefined;
      slot.apiPoolExhausted = false;
      slot.autoPoolExhausted = false;
      slot.cooldownUntil = 0;
      slot.consecutiveRateLimits = 0;
      this.persist();
    }
  }

  addKey(rawKey: string, enabled = true, label?: string, proxyUrl?: string): KeySlotStatus {
    let validProxy: string | undefined;
    try {
      validProxy = validateProxyUrl(proxyUrl);
    } catch (err) {
      throw new GatewayError(err instanceof Error ? err.message : "Invalid proxy URL.", 400, "invalid_proxy_url");
    }
    let normalized = rawKey.trim();
    const webCred = parseWebCurlOrCredential(normalized);
    if (webCred) {
      normalized = serializeWebCredential(webCred);
      // Manual renewal: if a web credential for the same AWS account already exists, refresh it in place.
      const prefix = `web:${webCred.accountId}|`;
      const existing = this.slots.find((s) => s.rawKey.startsWith(prefix));
      if (existing) {
        existing.quotaRevision++;
        existing.rawKey = normalized;
        existing.maskedKey = maskSecretKey(normalized);
        existing.enabled = enabled;
        existing.autoDisabledKind = undefined;
        existing.autoDisabledReason = undefined;
        existing.cooldownUntil = 0;
        if (label?.trim()) existing.label = label.trim();
        if (proxyUrl !== undefined) existing.proxyUrl = validProxy;
        this.persist();
        return this.toSlotStatus(existing, this.affinityTable.countBySlot());
      }
    } else if (!normalized || normalized.length < 4 || /[\r\n]/.test(normalized)) {
      throw new GatewayError(
        "Invalid AWS Quick credential (use `local-outpost`, `id_token`, or pasted `Copy as cURL` from quick.aws.com).",
        400,
        "invalid_api_key",
      );
    }
    const autoWebLabel = webCred ? (webCred.email || `AWS #${webCred.accountId.slice(-4)}`) : undefined;
    const slot = this.upsertInternal(normalized, enabled, label || autoWebLabel);
    if (proxyUrl !== undefined) slot.proxyUrl = validProxy;
    this.persist();
    return this.toSlotStatus(slot, this.affinityTable.countBySlot());
  }

  updateSlotMeta(
    slotId: string,
    patch: { enabled?: boolean; label?: string; proxyUrl?: string; clearCooldown?: boolean; maxConcurrent?: number; weight?: number }
  ): KeySlotStatus {
    const slot = this.slots.find((s) => s.slotId === slotId);
    if (!slot) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");

    for (const name of ["maxConcurrent", "weight"] as const) {
      if (patch[name] !== undefined) {
        const n = patch[name]!;
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new GatewayError(`${name} must be between 1 and 100.`, 400, "invalid_account_limit");
      }
    }
    if (patch.maxConcurrent !== undefined) slot.maxConcurrent = patch.maxConcurrent;
    if (patch.weight !== undefined) slot.weight = patch.weight;
    if (patch.clearCooldown) {
      slot.quotaRevision++;
      slot.cooldownUntil = 0;
      slot.cooldownReason = undefined;
      slot.consecutiveRateLimits = 0;
    }
    if (patch.label !== undefined) {
      slot.label = patch.label.trim() || undefined;
    }
    if (patch.proxyUrl !== undefined) {
      try {
        slot.proxyUrl = validateProxyUrl(patch.proxyUrl);
        slot.quotaRevision++;
      } catch (err) {
        throw new GatewayError(err instanceof Error ? err.message : "Invalid proxy URL.", 400, "invalid_proxy_url");
      }
    }
    if (typeof patch.enabled === "boolean") {
      slot.quotaRevision++;
      slot.enabled = patch.enabled;
      if (patch.enabled) {
        slot.cooldownUntil = 0;
        slot.cooldownReason = undefined;
        slot.consecutiveRateLimits = 0;
        slot.autoDisabledReason = undefined;
        slot.autoDisabledKind = undefined;
        slot.autoResetAtMs = undefined;
        slot.autoPoolExhausted = false;
        slot.apiPoolExhausted = false;
      } else {
        slot.autoDisabledReason = undefined;
        slot.autoDisabledKind = undefined;
        slot.autoResetAtMs = undefined;
        this.affinityTable.evictAllForKey(slot.rawKey);
      }
    }
    this.persist();
    return this.toSlotStatus(slot, this.affinityTable.countBySlot());
  }

  removeKey(slotId: string): void {
    const idx = this.slots.findIndex((s) => s.slotId === slotId);
    if (idx < 0) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const [removed] = this.slots.splice(idx, 1);
    if (removed) {
      this.affinityTable.evictAllForKey(removed.rawKey);
      evictQuotaCachesForKey(removed.rawKey);
    }
    this.persist();
  }

  affinitySnapshot(limit = 50): AffinityBindingView[] {
    return this.affinityTable.snapshot(limit);
  }

  clearAffinity(): void {
    this.affinityTable.clearAll();
  }

  private toSlotStatus(slot: InternalKeySlot, stickyCounts: Map<string, number>): KeySlotStatus {
    const rem = Math.max(0, slot.cooldownUntil - Date.now());
    return {
      slotId: slot.slotId,
      ...(slot.label ? { label: slot.label } : {}),
      authType: slot.authType,
      addedAt: slot.addedAt,
      maskedKey: slot.maskedKey,
      ...(slot.proxyUrl ? { maskedProxy: maskProxyUrl(slot.proxyUrl) } : {}),
      enabled: slot.enabled,
      healthy: slot.enabled && rem === 0 && !slot.autoPoolExhausted && !slot.apiPoolExhausted,
      ...(slot.autoDisabledReason ? { autoDisabledReason: slot.autoDisabledReason } : {}),
      ...(slot.autoDisabledKind && !slot.enabled ? { autoDisabledKind: slot.autoDisabledKind } : {}),
      ...(slot.autoDisabledKind === "quota" && slot.autoResetAtMs ? { autoRecoverAt: new Date(slot.autoResetAtMs).toISOString() } : {}),
      apiPoolExhausted: slot.apiPoolExhausted,
      autoPoolExhausted: slot.autoPoolExhausted,
      activeInflight: slot.activeInflight,
      maxConcurrent: slot.maxConcurrent,
      weight: slot.weight,
      stickySessions: stickyCounts.get(slot.slotId) ?? 0,
      cooldownRemainingMs: rem,
      ...(rem > 0 ? { cooldownUntil: new Date(slot.cooldownUntil).toISOString(), cooldownReason: slot.cooldownReason } : {}),
      totalSelected: slot.selected,
      affinityHits: slot.affinityHits,
      rateLimitHits: slot.rateLimits,
      quotaExhaustedHits: slot.quotaExhaustedHits,
      authErrors: slot.authErrors,
      ...(slot.identity ? { identity: slot.identity } : {}),
      ...(slot.quota ? { quota: slot.quota } : {}),
      ...(slot.bot ? { bot: slot.bot } : {}),
      ...(slot.cloudSessionCount !== undefined ? { cloudSessionCount: slot.cloudSessionCount } : {}),
      ...(slot.tokenRemainingSec !== undefined ? { tokenRemainingSec: slot.tokenRemainingSec } : {}),
      ...(slot.lastSyncError ? { lastSyncError: slot.lastSyncError } : {}),
      ...(slot.quotaUpdatedAt ? { quotaUpdatedAt: slot.quotaUpdatedAt } : {})
    };
  }

  statusSnapshot(): KeySlotStatus[] {
    this.reviveCycleResetAccounts();
    const stickyCounts = this.affinityTable.countBySlot();
    return this.slots.map((s) => this.toSlotStatus(s, stickyCounts));
  }
}

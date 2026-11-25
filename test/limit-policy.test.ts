import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyAccountLimit, parseResetTime, retryAtFromUpstream } from "../src/core/limit-policy.js";
import { UpstreamKeyPool, computeKeySlotId } from "../src/core/key-pool.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { GatewayError } from "../src/core/types.js";
import type { QuickPlanQuotaView } from "../src/services/quota-service.js";
import { createGatewayServer } from "../src/server.js";
import { QuickExecutionEngine, mapSdkError } from "../src/core/engine.js";
import { parseAnthropicMessagesRequest } from "../src/protocols/anthropic.js";
import { UsageTracker } from "../src/services/usage-tracker.js";

function quota(session: number | null, monthly: number | null, reset: number): QuickPlanQuotaView {
  return { membershipType: "test", billingCycleEnd: new Date(reset).toISOString(),
    sessionPool: { usedPercent: null, remainingPercent: session, resetAt: new Date(reset).toISOString() },
    premiumApiPool: { usedPercent: null, remainingPercent: monthly },
    overallIncludedPlan: { usedPercent: null, remainingPercent: monthly, allowanceUsd: null },
    onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null } };
}

describe("Temporary account cooldown policy", () => {
  afterEach(() => mock.restoreAll());
  it("separates temporary limits, definite quota, auth and content errors", () => {
    assert.equal(classifyAccountLimit(new GatewayError("Usage limit reached.", 429, "usage_limit_reached"))?.kind, "temporary");
    assert.equal(classifyAccountLimit(new GatewayError("Rate limit exceeded", 502))?.kind, "temporary");
    assert.equal(classifyAccountLimit(new GatewayError("Monthly quota exhausted", 402, "quota_exhausted"))?.kind, "quota");
    assert.equal(classifyAccountLimit(new GatewayError("quota in invalid tool input", 502, "invalid_tool_call")), undefined);
    assert.equal(classifyAccountLimit(new GatewayError("Content filtered", 400, "content_filter")), undefined);
    assert.equal(classifyAccountLimit(new GatewayError("Credentials expired", 401)), undefined);
  });

  it("parses explicit recovery dates and delays, ignores ambiguous or stale dates", () => {
    const now = Date.parse("2026-11-25T00:00:00Z");
    const reset = now + 120000;
    for (const value of [reset, reset / 1000, String(reset / 1000), new Date(reset).toISOString()]) assert.equal(parseResetTime(value, now), reset);
    assert.equal(retryAtFromUpstream({ retry_after: 120 }, now), reset);
    assert.equal(retryAtFromUpstream({ headers: { "retry-after": new Date(reset).toUTCString() } }, now), reset);
    assert.equal(retryAtFromUpstream({ details: { reset_at: reset / 1000 } }, now), reset);
    assert.equal(retryAtFromUpstream({ message: "Retry in 2 minutes." }, now), reset);
    assert.equal(retryAtFromUpstream({ message: "Resets at 2026-11-25T00:02:00Z" }, now), reset);
    assert.equal(retryAtFromUpstream({ retry_after_ms: 120000 }, now), reset);
    for (const value of ["tomorrow", "12:00", now - 1000, "invalid", Infinity]) assert.equal(parseResetTime(value, now), undefined);
  });

  it("persists temporary cooldowns across restart and restores scheduling at expiry", (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quick-cooldown-"));
    const file = path.join(dir, ".env");
    const now = Date.now();let clockNow = now;t.mock.method(Date, "now", () => clockNow);t.after(() => t.mock.restoreAll());
    writeFileSync(file, "QUICK_TOKENS=account-a,account-b\n");
    let pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "account-a,account-b", TEMPORARY_LIMIT_COOLDOWN_SECONDS: "12", LB_STRATEGY: "round-robin" }, file));
    try {
      const first = pool.leaseKey("claude-opus-5-5", undefined, "same-thread");first.release();
      pool.reportTemporaryLimit(first.apiKey);
      const state = pool.statusSnapshot().find((s) => s.slotId === first.slotId)!;
      assert.equal(state.enabled, true);assert.equal(state.cooldownRemainingMs, 12000);assert.equal(state.autoPoolExhausted, false);
      assert.equal(pool.affinitySnapshot().length, 0);
      const next = pool.leaseKey("claude-opus-5-5", undefined, "same-thread");assert.notEqual(next.slotId, first.slotId);next.release();
      assert.match(readFileSync(file, "utf8"), /KEY_COOLDOWNS=/);
      pool.close();pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "stale-startup-value" }, file));
      assert.equal(pool.getSettings().temporaryLimitCooldownSeconds, 12);
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === first.slotId)!.cooldownRemainingMs, 12000);
      clockNow = now + 12001;
      assert.equal(pool.isKeyUsable(first.apiKey), true);
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === first.slotId)!.cooldownRemainingMs, 0);
      assert.match(readFileSync(file, "utf8"), /KEY_COOLDOWNS=\{\}/);
    } finally { pool.close();rmSync(dir, { recursive: true, force: true }); }
  });

  it("honors explicit retry time over the default and does not shorten concurrent cooldowns", (t) => {
    const now = Date.now();let clockNow = now;t.mock.method(Date, "now", () => clockNow);t.after(() => t.mock.restoreAll());
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "test-account", TEMPORARY_LIMIT_COOLDOWN_SECONDS: "300" }));
    try {
      pool.reportTemporaryLimit("test-account", now + 15000);
      assert.equal(pool.statusSnapshot()[0]!.cooldownRemainingMs, 15000);
      pool.reportTemporaryLimit("test-account", now + 5000);
      assert.equal(pool.statusSnapshot()[0]!.cooldownRemainingMs, 15000);
      pool.reportTemporaryLimit("test-account", now + 600000);
      assert.equal(pool.statusSnapshot()[0]!.cooldownRemainingMs, 600000);
    } finally { pool.close(); }
  });

  it("preserves definite quota recovery across restart, including non-disabling mode and unknown resets", (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quick-quota-reset-"));const file = path.join(dir, ".env");
    const now = Date.now();let clockNow = now;t.mock.method(Date, "now", () => clockNow);t.after(() => t.mock.restoreAll());
    writeFileSync(file, "QUICK_TOKENS=explicit,unknown,manual\n");
    let pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "explicit,unknown,manual", AUTO_DISABLE_EXHAUSTED_KEYS: "false" }, file));
    try {
      pool.reportQuotaExhausted("explicit", "auto", "Monthly quota exhausted", now + 60000);
      pool.reportQuotaExhausted("unknown", "auto", "Credits exhausted");
      pool.reportQuotaExhausted("manual", "auto", "Credits exhausted");
      pool.updateSlotMeta(computeKeySlotId("manual"), { enabled: false });
      pool.reportQuotaExhausted("manual", "auto", "A late result after manual disable", now + 1000);
      assert.equal(pool.isKeyUsable("explicit"), false);
      pool.close();pool = new UpstreamKeyPool(loadConfigFromEnv({}, file));
      assert.equal(pool.isKeyUsable("explicit"), false);
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId("unknown"))!.autoRecoverAt, new Date(now + 3600000).toISOString());
      clockNow = now + 60001;
      assert.equal(pool.isKeyUsable("explicit"), true);assert.equal(pool.isKeyUsable("unknown"), false);
      clockNow = now + 3600001;
      assert.equal(pool.isKeyUsable("unknown"), true);assert.equal(pool.isKeyUsable("manual"), false);
    } finally { pool.close();rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns the remaining cooldown when the account wait times out", async () => {
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "cooling", QUEUE_WAIT_TIMEOUT_MS: "10" }));
    try {
      pool.reportTemporaryLimit("cooling", Date.now() + 120000);
      await assert.rejects(pool.acquireKey("auto"), (error: unknown) => error instanceof GatewayError && error.code === "account_queue_timeout" && (error as GatewayError & { retryAfter: number }).retryAfter >= 119);
    } finally { pool.close(); }
  });

  it("keeps upstream retry metadata while failing over the unchanged request", async () => {
    const config = loadConfigFromEnv({ QUICK_TOKENS: "limited,healthy", LB_STRATEGY: "round-robin" });
    const pool = new UpstreamKeyPool(config);const engine = new QuickExecutionEngine({ config, usageTracker: new UsageTracker() });
    const turn = parseAnthropicMessagesRequest({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "写两句周末书店文案。" }] });
    const before = JSON.stringify(turn);const retryAtMs = Date.now() + 120000;let attempts = 0;
    Object.assign(engine, { executeTurnWithLease: async function* (actual: unknown) {
      assert.equal(JSON.stringify(actual), before);
      if (++attempts === 1) throw mapSdkError(Object.assign(new Error("Rate limit reached"), { retry_after: 120 }));
      yield { type: "text", text: "周末来书店坐坐。带一本好书回家。" };yield { type: "done", stopReason: "stop" };
    } });
    try {
      const events = [];for await (const event of engine.executeTurnWithPool(turn, pool)) events.push(event);
      assert.equal(attempts, 2);assert.ok(events.some((event) => event.type === "text"));
      const cooling = pool.statusSnapshot().find((s) => s.cooldownUntil)!;
      assert.equal(cooling.enabled, true);assert.ok(Math.abs(Date.parse(cooling.cooldownUntil!) - retryAtMs) < 1000);
      assert.ok(pool.statusSnapshot().every((s) => s.activeInflight === 0));
    } finally { pool.close(); }
  });

  it("uses the session reset for short windows and monthly reset for definite exhaustion", (t) => {
    const now = Date.now();let clockNow = now;t.mock.method(Date, "now", () => clockNow);t.after(() => t.mock.restoreAll());
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "short-window,monthly,manual,auth" }));
    try {
      pool.updateSlotQuotaCache("short-window", undefined, quota(0, 80, now + 30000));
      const short = pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId("short-window"))!;
      assert.equal(short.enabled, true);assert.equal(short.cooldownRemainingMs, 30000);assert.equal(short.autoPoolExhausted, false);
      pool.updateSlotQuotaCache("monthly", undefined, quota(80, 0, now + 90000));
      const monthly = pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId("monthly"))!;
      assert.equal(monthly.enabled, false);assert.equal(monthly.autoRecoverAt, new Date(now + 90000).toISOString());
      pool.updateSlotMeta(computeKeySlotId("manual"), { enabled: false });pool.reportAuthFailure("auth");
      clockNow = now + 30001;assert.equal(pool.isKeyUsable("short-window"), true);
      assert.equal(pool.isKeyUsable("monthly"), false);
      clockNow = now + 90001;assert.equal(pool.isKeyUsable("monthly"), true);
      assert.equal(pool.isKeyUsable("manual"), false);assert.equal(pool.isKeyUsable("auth"), false);
    } finally { pool.close(); }
  });

  it("migrates only the earlier generic usage-limit trip and leaves manual/auth disablement intact", () => {
    const env = loadConfigFromEnv({ QUICK_TOKENS: "", DISABLED_QUICK_TOKENS: "old-usage,manual,auth,monthly", KEY_AUTO_DISABLED: JSON.stringify({
      [computeKeySlotId("old-usage")]: { kind: "quota", reason: "Auto-disabled (quota exhausted): AWS Quick account reached its usage limit (quota_exhausted)." },
      [computeKeySlotId("auth")]: { kind: "auth", reason: "Authentication failed" },
      [computeKeySlotId("monthly")]: { kind: "quota", reason: "Monthly pool exhausted" },
    }) });
    const pool = new UpstreamKeyPool(env);
    try {
      const state = pool.statusSnapshot();
      const old = state.find((s) => s.slotId === computeKeySlotId("old-usage"))!;
      assert.equal(old.enabled, true);assert.ok(old.cooldownRemainingMs > 0);
      assert.equal(state.filter((s) => s.enabled).length, 1);
    } finally { pool.close(); }
  });

  it("validates the live admin setting and reloads its persisted value", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quick-setting-"));const file = path.join(dir, ".env");
    writeFileSync(file, "QUICK_TOKENS=test-account\n");
    const config = loadConfigFromEnv({ QUICK_TOKENS: "test-account", ADMIN_PASSWORD: "test-admin", DATA_DIR: dir }, file);
    const gateway = createGatewayServer({ config });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}/v1/admin/settings`;
    try {
      for (const value of [0, -1, 86401, 1.5, "60"]) {
        const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: JSON.stringify({ temporaryLimitCooldownSeconds: value }) });assert.equal(r.status, 400);
      }
      const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: JSON.stringify({ temporaryLimitCooldownSeconds: 600 }) });
      assert.equal(r.status, 200);assert.equal((await r.json() as { settings: { temporaryLimitCooldownSeconds: number } }).settings.temporaryLimitCooldownSeconds, 600);
      assert.equal(loadConfigFromEnv({ TEMPORARY_LIMIT_COOLDOWN_SECONDS: "300" }, file).temporaryLimitCooldownSeconds, 600);
    } finally { await gateway.close();rmSync(dir, { recursive: true, force: true }); }
  });
});

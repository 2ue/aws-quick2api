import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LimitQuotaProbe } from "../src/services/limit-quota-probe.js";
import { fetchAccountUsageQuota, parseQuickPlanQuota, type QuickPlanQuotaView } from "../src/services/quota-service.js";
import { UpstreamKeyPool, computeKeySlotId } from "../src/core/key-pool.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { GatewayError } from "../src/core/types.js";
import { parseAnthropicMessagesRequest } from "../src/protocols/anthropic.js";
import { createGatewayServer } from "../src/server.js";
import { serializeOAuthCredential } from "../src/aws-quick/oauth-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function quota(session = 80, monthly = 80, reset = Date.now() + 600000): QuickPlanQuotaView {
  return parseQuickPlanQuota({ session: { used: 100 - session, limit: 100, percent: 100 - session, resets_at: reset },
    monthly: { used: 100 - monthly, limit: 100, resets_at: reset } });
}

describe("Limit-triggered quota diagnostics", () => {
  it("coalesces a concurrent account burst and throttles completed/failed probes", async (t) => {
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "limited" }));
    const response = deferred<QuickPlanQuotaView>();let calls = 0;
    const probe = new LimitQuotaProbe(pool, { fetcher: async () => { calls++;return response.promise; } });
    try {
      const tasks = Array.from({ length: 100 }, () => probe.trigger("limited"));
      assert.equal(calls, 1);assert.equal(probe.snapshot().coalesced, 99);
      response.resolve(quota());await Promise.all(tasks);
      await probe.trigger("limited");assert.equal(calls, 1);
      const now = Date.now();t.mock.method(Date, "now", () => now + 60001);t.after(() => t.mock.restoreAll());
      await probe.trigger("limited");assert.equal(calls, 2);
      assert.equal(pool.statusSnapshot()[0]!.quota!.sessionPool.remainingPercent, 80);
    } finally { probe.close();pool.close(); }
  });

  it("bounds global concurrency and queue size without losing inference capacity", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `account-${i}`);
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: keys.join(",") }));
    const gate = deferred<QuickPlanQuotaView>();let active = 0;let peak = 0;let calls = 0;
    const probe = new LimitQuotaProbe(pool, { maxQueued: 3, fetcher: async () => {
      calls++;active++;peak = Math.max(peak, active);
      try { return await gate.promise; } finally { active--; }
    } });
    try {
      const tasks = keys.map((key) => probe.trigger(key));
      assert.equal(probe.snapshot().active, 2);assert.equal(probe.snapshot().queued, 3);assert.equal(probe.snapshot().dropped, 15);
      const lease = pool.leaseKey();lease.release();
      assert.ok(pool.statusSnapshot().every((s) => s.activeInflight === 0));
      gate.resolve(quota());await Promise.all(tasks);
      assert.equal(peak, 2);assert.equal(calls, 5);assert.equal(probe.snapshot().active, 0);
    } finally { probe.close();pool.close(); }
  });

  it("aborts timed-out queries, preserves cooldown and ignores results after close", async () => {
    const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "slow,healthy" }));
    pool.reportTemporaryLimit("slow");const before = pool.statusSnapshot()[0]!.cooldownUntil;
    const late = deferred<QuickPlanQuotaView>();let signal: AbortSignal | undefined;let calls = 0;
    const probe = new LimitQuotaProbe(pool, { maxConcurrent: 1, timeoutMs: 20, fetcher: async (_, s) => { calls++;signal = s;return late.promise; } });
    try {
      await probe.trigger("slow");assert.equal(signal?.aborted, true);assert.equal(probe.snapshot().failed, 1);
      assert.equal(pool.statusSnapshot()[0]!.cooldownUntil, before);assert.equal(pool.statusSnapshot()[0]!.enabled, true);
      await probe.trigger("slow");assert.equal(calls, 1);
      const pending = probe.trigger("healthy");probe.close();await pending;
      late.resolve(quota(0, 0));await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(pool.statusSnapshot().every((s) => s.enabled));assert.equal(pool.statusSnapshot()[1]!.quota, undefined);
    } finally { probe.close();pool.close(); }
  });

  it("uses session and monthly resets without clearing actual rate limits on healthy/unknown telemetry", async () => {
    for (const [name, view] of [["session", quota(0, 80)], ["monthly", quota(80, 0)], ["healthy", quota()], ["unknown", parseQuickPlanQuota({})]] as const) {
      const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: name }));
      pool.reportTemporaryLimit(name);const before = pool.statusSnapshot()[0]!.cooldownUntil;
      const probe = new LimitQuotaProbe(pool, { fetcher: async () => view });
      try {
        await probe.trigger(name);const state = pool.statusSnapshot()[0]!;
        if (name === "monthly") { assert.equal(state.enabled, false);assert.equal(state.autoRecoverAt, view.billingCycleEnd); }
        else if (name === "session") { assert.equal(state.enabled, true);assert.equal(state.cooldownUntil, view.sessionPool.resetAt); }
        else { assert.equal(state.enabled, true);assert.equal(state.cooldownUntil, before); }
      } finally { probe.close();pool.close(); }
    }
  });

  it("discards late telemetry after manual changes, auth failure, newer sync or slot replacement", async () => {
    for (const operation of ["disable", "reenable", "unblock", "auth", "sync", "replace", "quota"]) {
      const pool = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: "account" }));
      const update = pool.createLimitQuotaUpdater("account")!;const id = computeKeySlotId("account");
      if (operation === "disable") pool.updateSlotMeta(id, { enabled: false });
      if (operation === "reenable") pool.updateSlotMeta(id, { enabled: true });
      if (operation === "unblock") pool.updateSlotMeta(id, { clearCooldown: true });
      if (operation === "auth") pool.reportAuthFailure("account");
      if (operation === "sync") pool.updateSlotQuotaCache("account", undefined, quota());
      if (operation === "replace") { pool.removeKey(id);pool.addKey("account"); }
      if (operation === "quota") pool.reportQuotaExhausted("account", "auto", "Newer explicit quota failure", Date.now() + 900000);
      try {
        const before = JSON.stringify(pool.statusSnapshot());update(quota(0, 0));
        assert.equal(JSON.stringify(pool.statusSnapshot()), before, operation);
      } finally { pool.close(); }
    }
  });

  it("queries only usage through account-local OAuth credentials and propagates cancellation", async (t) => {
    const key = serializeOAuthCredential({ region: "us-east-1", issuerUrl: "https://example.com", wsHost: "test.quick.aws.com",
      clientId: "diagnostic-client", clientSecret: "dummy-secret", refreshToken: "dummy-refresh", accessToken: "dummy-access", expiresAt: Date.now() + 3600000 });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls++;assert.equal(url, "https://test.quick.aws.com/integration/quick-work/qbs-event");
      const payload = JSON.parse(init.body as string);assert.equal(payload.eventBody.invokeAgent.path, "profile/usage");
      assert.ok(init.signal);
      return new Response(JSON.stringify({ eventResponse: { invokeAgentResponse: { body: JSON.stringify({ session: { used: 100, limit: 100, resets_at: Date.now() + 90000 }, monthly: { used: 12, limit: 600 } }) } } }));
    });t.after(() => t.mock.restoreAll());
    const view = await fetchAccountUsageQuota(key, new AbortController().signal);
    assert.equal(calls, 1);assert.equal(view.sessionPool.remainingPercent, 0);assert.equal(view.premiumApiPool.remainingPercent, 98);
    const controller = new AbortController();controller.abort();
    await assert.rejects(fetchAccountUsageQuota(key, controller.signal));assert.equal(calls, 1);
  });

  it("keeps absent/invalid usage unknown and does not round a nearly depleted account down to exhausted", () => {
    for (const usage of [{}, { monthly: { used: 0, limit: 0 } }, { monthly: { used: null, limit: 100 } }, { monthly: { used: 1, limit: Infinity } }]) {
      assert.equal(parseQuickPlanQuota(usage as never).premiumApiPool.remainingPercent, null);
    }
    assert.equal(parseQuickPlanQuota({ monthly: { used: 599.99, limit: 600 } }).premiumApiPool.remainingPercent, 0.1);
    assert.equal(parseQuickPlanQuota({ monthly: { used: 600, limit: 600 } }).premiumApiPool.remainingPercent, 0);
  });

  it("keeps Web and imported-token usage probes isolated and retains cooldown on unsupported local credentials", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls++;
      const body = JSON.stringify({ monthly: { used: 600, limit: 600 } });
      if (url.startsWith("https://quick.aws.com/sn/account/")) {
        assert.ok(url.includes("/invocations/profile/usage?"));assert.equal((init.headers as Record<string, string>).Cookie, "aws-ds-access-token=dummy_tok");
        return new Response(JSON.stringify({ body }));
      }
      assert.equal(url, "https://test.quick.aws.com/integration/quick-work/qbs-event");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer dummy-token");
      assert.equal(JSON.parse(init.body as string).eventBody.invokeAgent.path, "profile/usage");
      return new Response(JSON.stringify({ eventResponse: { invokeAgentResponse: { body } } }));
    });t.after(() => t.mock.restoreAll());
    const signal = new AbortController().signal;
    assert.equal((await fetchAccountUsageQuota("web:123456789012|dummy-csrf|aws-ds-access-token=dummy_tok", signal)).premiumApiPool.remainingPercent, 0);
    assert.equal((await fetchAccountUsageQuota("test.quick.aws.com|dummy-token", signal)).premiumApiPool.remainingPercent, 0);
    await assert.rejects(fetchAccountUsageQuota("local-outpost", signal), /requires OAuth/);
    await assert.rejects(fetchAccountUsageQuota("evil.invalid|dummy-token", signal), /Invalid AWS Quick host/);
    assert.equal(calls, 2);
  });

  it("starts diagnostics from the real inference failure path without awaiting it, and excludes unrelated errors", async () => {
    const config = loadConfigFromEnv({ QUICK_TOKENS: "limited,healthy", LB_STRATEGY: "round-robin", ADMIN_PASSWORD: "test-admin" });
    const delayed = deferred<QuickPlanQuotaView>();let queries = 0;
    const gateway = createGatewayServer({ config, limitQuotaFetcher: async () => { queries++;return delayed.promise; } });
    let attempts = 0;
    Object.assign(gateway.engine, { executeTurnWithLease: async function* () {
      if (++attempts === 1) throw new GatewayError("Usage limit reached", 429, "usage_limit_reached");
      yield { type: "text", text: "成功" };yield { type: "done", stopReason: "stop" };
    } });
    const turn = parseAnthropicMessagesRequest({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "普通问答" }] });
    try {
      const output = [];for await (const event of gateway.engine.executeTurnWithPool(turn, gateway.keyPool)) output.push(event);
      assert.equal(attempts, 2);assert.equal(queries, 1);assert.ok(output.some((e) => e.type === "text"));
      delayed.resolve(quota());await new Promise<void>((resolve) => setImmediate(resolve));
      Object.assign(gateway.engine, { executeTurnWithLease: async function* () { throw new GatewayError("Content filtered", 400, "content_filter"); } });
      await assert.rejects(async () => { for await (const _ of gateway.engine.executeTurnWithPool(turn, gateway.keyPool)) { /* consume */ } });
      assert.equal(queries, 1);
    } finally { await gateway.close(); }
  });
});

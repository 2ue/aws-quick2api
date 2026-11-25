import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaReplyGuard } from "../src/core/quota-reply-guard.js";
import { QuickExecutionEngine } from "../src/core/engine.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { UpstreamKeyPool } from "../src/core/key-pool.js";
import { GatewayError, type GatewayStreamEvent } from "../src/core/types.js";
import { parseAnthropicMessagesRequest } from "../src/protocols/anthropic.js";
import { UsageTracker } from "../src/services/usage-tracker.js";

const QUOTA = "You've reached your usage limit. Check your profile for details.";
const DONE = { type: "done", stopReason: "stop" } as const;
const ROUTE = { type: "thinking", text: "[AWS Quick] mode=smart · effort=off · routed=opus" } as const;

describe("Quota replies returned as successful upstream text", () => {
  it("buffers split platform messages and routing metadata without exposing a false success", () => {
    for (const text of [QUOTA, "  You have reached your usage limit. Check your profile for details\n", QUOTA.replace("'", "’")]) {
      for (let size = 1; size <= text.length; size++) {
        const guard = new QuotaReplyGuard();
        assert.deepEqual(guard.feed(ROUTE, true), []);
        for (let i = 0; i < text.length; i += size) assert.deepEqual(guard.feed({ type: "text", text: text.slice(i, i + size) }), []);
        assert.throws(() => guard.feed(DONE), (error: unknown) => error instanceof GatewayError && error.status === 429 && error.code === "usage_limit_reached");
      }
    }
  });

  it("preserves explanations, quotations, code and real thinking without misclassifying account exhaustion", () => {
    for (const text of [QUOTA+" This is an example error; try checking the account dashboard.", 'The error says: "'+QUOTA+'"', '```text\n'+QUOTA+'\n```', "你好，下面是方案。", "You", ""]) {
      const guard = new QuotaReplyGuard();
      const emitted = [...guard.feed(ROUTE, true)];
      for (const char of text) emitted.push(...guard.feed({ type: "text", text: char }));
      emitted.push(...guard.feed(DONE));
      assert.equal(emitted.filter((e) => e.type === "text").map((e) => e.text).join(""), text);
      assert.deepEqual(emitted[0], ROUTE);
      assert.deepEqual(emitted.at(-1), DONE);
    }
    const guard = new QuotaReplyGuard();
    assert.deepEqual(guard.feed({ type: "thinking", text: "I am explaining an account error." }), [{ type: "thinking", text: "I am explaining an account error." }]);
    assert.deepEqual(guard.feed({ type: "text", text: QUOTA }), [{ type: "text", text: QUOTA }]);
    assert.deepEqual(guard.feed(DONE), [DONE]);
    const quoted = new QuotaReplyGuard();
    assert.deepEqual(quoted.feed({ type: "text", text: QUOTA }), []);
    const generatedUsage = { type: "usage", metrics: { inputTokens: 30, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 } } as const;
    assert.deepEqual(quoted.feed(generatedUsage), [{ type: "text", text: QUOTA }, generatedUsage]);
    assert.deepEqual(quoted.feed(DONE), [DONE]);
  });

  it("evicts the exhausted account's affinity and retries the unchanged request on another account", async () => {
    const config = loadConfigFromEnv({ QUICK_TOKENS: "test-exhausted,test-healthy", LB_STRATEGY: "round-robin", SESSION_AFFINITY_ENABLED: "true" });
    const pool = new UpstreamKeyPool(config);
    const engine = new QuickExecutionEngine({ config, usageTracker: new UsageTracker() });
    const attempted: string[] = [];
    Object.assign(engine, { executeTurnWithLease: async function* (turn: unknown, lease: { apiKey: string }) {
      attempted.push(lease.apiKey);
      const guard = new QuotaReplyGuard();
      for (const event of guard.feed(ROUTE, true)) yield event;
      for (const event of guard.feed({ type: "text", text: attempted.length === 1 ? QUOTA : "完整答案" })) yield event;
      for (const event of guard.feed(DONE)) yield event;
    } });
    const turn = parseAnthropicMessagesRequest({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "比较两个知识库方案。" }] }, { "x-conversation-id": "quota-failover-test" });
    const before = JSON.stringify(turn.rawBody);
    try {
      const events: GatewayStreamEvent[] = [];
      for await (const e of engine.executeTurnWithPool(turn, pool)) events.push(e);
      assert.equal(attempted.length, 2);
      assert.notEqual(attempted[0], attempted[1]);
      assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "完整答案");
      assert.equal(events.filter((e) => e.type === "thinking").length, 1);
      assert.equal(JSON.stringify(turn.rawBody), before);
      const state = pool.statusSnapshot();
      assert.equal(state.filter((s) => s.enabled && s.cooldownRemainingMs > 0).length, 1);
      assert.ok(state.every((s) => s.autoDisabledKind !== "quota"));
      assert.ok(state.every((s) => s.activeInflight === 0));
      assert.equal(pool.affinitySnapshot().length, 1);
    } finally { pool.close(); }
  });

  it("does not restart after real output and returns quota failure if every account is exhausted", async () => {
    for (const partial of [false, true]) {
      const config = loadConfigFromEnv({ QUICK_TOKENS: "test-quota-a,test-quota-b", SESSION_AFFINITY_ENABLED: "false" });
      const pool = new UpstreamKeyPool(config);
      const engine = new QuickExecutionEngine({ config, usageTracker: new UsageTracker() });
      let attempts = 0;
      Object.assign(engine, { executeTurnWithLease: async function* () {
        attempts++;
        if (partial) yield { type: "text", text: "Some actual content." };
        throw new GatewayError("Account usage limit.", 402, "quota_exhausted");
      } });
      const turn = parseAnthropicMessagesRequest({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Explain closures." }] });
      try {
        await assert.rejects(async () => { for await (const _ of engine.executeTurnWithPool(turn, pool)) { /* consume */ } }, (e: unknown) => e instanceof GatewayError && e.code === "quota_exhausted");
        assert.equal(attempts, partial ? 1 : 2);
        assert.ok(pool.statusSnapshot().every((s) => s.activeInflight === 0));
      } finally { pool.close(); }
    }
  });
});

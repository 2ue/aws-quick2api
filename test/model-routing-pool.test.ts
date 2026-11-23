import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolveModelRoute, canonicalModelId } from "../src/services/model-router.js";
import { ModelAccessController } from "../src/services/model-access.js";
import { ClientGatewayKeyManager } from "../src/services/client-keys.js";
import { RequestAdmission } from "../src/core/request-admission.js";
import { UpstreamKeyPool, computeKeySlotId } from "../src/core/key-pool.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { serializeOAuthCredential, parseOAuthCredential } from "../src/aws-quick/oauth-client.js";
import { persistRefreshedOAuthTokens } from "../src/aws-quick/oauth-token-store.js";
import { createGatewayServer } from "../src/server.js";
import type { ParsedProtocolTurn, GatewayStreamEvent } from "../src/core/types.js";

function pool(count = 20, extra = {}) {
  return new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: Array.from({ length: count }, (_, i) => `test-account-${i}`).join(","),
    ACCOUNT_MAX_CONCURRENT: "2", LB_STRATEGY: "quota-aware", SESSION_AFFINITY_ENABLED: "false", ...extra }));
}

describe("Unified model routing", () => {
  it("maps Claude Code thinking aliases, effort levels and enablement forms", () => {
    for (const model of ["claude-sonnet-5-5-think", "claude-sonnet-5-5-thinking", "claude-opus-5-5-ultrathink"]) {
      assert.equal(resolveModelRoute(model).thinkingEffort, "high");
    }
    assert.equal(resolveModelRoute("claude-sonnet-5-5-thinking-low").thinkingEffort, "low");
    for (const body of [{ thinking: true }, { thinking: { enabled: true } }, { thinking: { type: "adaptive" } },
      { enable_thinking: true }, { output_config: { effort: "xhigh" } }, { reasoning: { effort: "max" } },
      { thinking: { effort: "ultrathink" } }]) {
      assert.equal(resolveModelRoute("claude-sonnet-5-5", body).thinkingEffort, "high");
    }
    assert.equal(resolveModelRoute("claude-sonnet-5-5", { thinking: { type: "enabled", budget_tokens: 4096 } }).thinkingEffort, "medium");
    assert.equal(resolveModelRoute("claude-sonnet-5-5-think", { thinking: false }).thinkingEffort, "off");
    assert.throws(() => resolveModelRoute("claude-sonnet-5-5", { thinking: { enabled: "true" } }), /boolean/);
    assert.throws(() => resolveModelRoute("claude-sonnet-5-5", { thinking: { type: "mystery" } }), /thinking.type/);
  });

  it("recognizes ultrathink in the current user request without reading tool outputs or system instructions", () => {
    for (const body of [{ input: "ultrathink solve this" }, { input: [{ role: "user", content: [{ type: "input_text", text: "ultrathink solve this" }] }] },
      { messages: [{ role: "user", content: "ultrathink solve this" }, { role: "assistant", content: "Calling tool" }, { role: "user", content: [{ type: "tool_result", content: "result" }] }] }]) {
      const route = resolveModelRoute("claude-sonnet-5-5", body);
      assert.equal(route.thinkingEffort, "high");
      assert.ok(route.normalizations.includes("ultrathink:high"));
    }
    assert.equal(resolveModelRoute("claude-sonnet-5-5", { messages: [{ role: "system", content: "ultrathink" }, { role: "user", content: "hello" }] }).thinkingEffort, "off");
    assert.equal(resolveModelRoute("claude-sonnet-5-5", { messages: [{ role: "user", content: "ultrathink old task" }, { role: "assistant", content: "done" }, { role: "user", content: "new task" }] }).thinkingEffort, "off");
    assert.equal(resolveModelRoute("claude-sonnet-5-5", { input: "ultrathink", thinking: { type: "disabled" } }).thinkingEffort, "off");
    assert.equal(resolveModelRoute("claude-sonnet-5-5", { input: "ultrathink", reasoning: { effort: "low" } }).thinkingEffort, "low");
    assert.equal(resolveModelRoute("claude-haiku-5-5", { input: "ultrathink" }).thinkingEffort, "off");
  });

  it("accepts explicit aliases without accepting unknown versions", () => {
    for (const [model, mode] of [["claude-haiku-5-5", "fast"], ["claude-sonnet-5.5", "balanced"], ["us.anthropic.claude-opus-5-5", "smart"]]) {
      assert.equal(resolveModelRoute(model).agentMode, mode);
    }
    assert.equal(resolveModelRoute("quick-balanced-think").thinkingEffort, "medium");
    assert.equal(resolveModelRoute("claude-sonnet-5-5-think").thinkingEffort, "high");
    assert.equal(resolveModelRoute("claude-opus-5-5-think").thinkingEffort, "high");
    assert.throws(() => resolveModelRoute("claude-haiku-5-5-think"));
    assert.equal(resolveModelRoute("quick-opus-5.5-thinking").thinkingEffort, "high");
    for (const name of ["claude-opus-99", "gpt-5", "typo-opus", "quick-smart[bad=high]"]) assert.throws(() => resolveModelRoute(name));
    assert.throws(() => resolveModelRoute("quick-advanced"), /not enabled/);
  });

  it("normalizes all protocol effort fields and rejects conflicting requests", () => {
    for (const body of [{ reasoning_effort: "high" }, { reasoning: { effort: "high" } },
      { thinking: { type: "adaptive" }, output_config: { effort: "high" } }]) {
      assert.equal(resolveModelRoute("claude-opus-5-5", body).thinkingEffort, "high");
    }
    assert.equal(resolveModelRoute("quick-smart[effort=low]", { reasoning_effort: "high" }).thinkingEffort, "high");
    assert.equal(resolveModelRoute("quick-fast", { reasoning_effort: "high" }).thinkingEffort, "off");
    assert.deepEqual(resolveModelRoute("quick-smart", { reasoning_effort: "max" }).normalizations, ["reasoning_effort:max-to-high"]);
    assert.throws(() => resolveModelRoute("quick-smart", { reasoning_effort: "high", reasoning: { effort: "low" } }), /Conflicting/);
    assert.throws(() => resolveModelRoute("quick-smart", { thinking: { type: "disabled" }, reasoning_effort: "high" }), /conflicts/);
  });

  it("uses the same model identity for list filtering and key permissions", () => {
    const access = new ModelAccessController({ disabledModels: ["quick-smart"], envFilePath: undefined });
    assert.throws(() => access.assertModelAllowed("claude-opus-5-5-high"));
    assert.doesNotThrow(() => access.assertModelAllowed("claude-sonnet-5-5"));
    const keys = new ClientGatewayKeyManager({ gatewayTokens: new Set() });
    const { rawToken } = keys.createKey({ name: "sonnet", allowAllModels: false, allowedModels: ["quick-balanced"] });
    const auth = keys.authenticateClient(rawToken);
    assert.doesNotThrow(() => keys.assertModelPermitted(auth, "claude-sonnet-5-5"));
    assert.throws(() => keys.assertModelPermitted(auth, "claude-opus-5-5"));
    assert.equal(canonicalModelId("amazon-balanced-high"), "claude-sonnet-5-5");
  });
});

describe("Bounded request admission", () => {
  it("limits global and per-client activity while allowing unrelated sessions", async () => {
    const admission = new RequestAdmission({ maxConcurrent: 2, maxQueued: 3, waitTimeoutMs: 1000 });
    const first = await admission.acquire({ clientKey: "one", clientLimit: 1, sessionKey: "a" });
    let admitted = false;
    const queued = admission.acquire({ clientKey: "one", clientLimit: 1, sessionKey: "b" }).then((release) => { admitted = true; return release; });
    const unrelated = await admission.acquire({ clientKey: "two", clientLimit: 1, sessionKey: "c" });
    assert.equal(admission.snapshot().active, 2);
    assert.equal(admitted, false);
    first();
    const second = await queued;
    assert.equal(admitted, true);
    second(); unrelated();
    assert.equal(admission.snapshot().active, 0);
    admission.close();
  });

  it("bounds queue length and removes canceled and timed-out waiters", async () => {
    const admission = new RequestAdmission({ maxConcurrent: 1, maxQueued: 1, waitTimeoutMs: 30 });
    const release = await admission.acquire({ clientKey: "a", clientLimit: 0 });
    const controller = new AbortController();
    const canceled = admission.acquire({ clientKey: "b", clientLimit: 0, signal: controller.signal });
    const rejected = assert.rejects(canceled, /canceled/);
    await assert.rejects(admission.acquire({ clientKey: "c", clientLimit: 0 }), /full/);
    controller.abort();
    await rejected;
    await assert.rejects(admission.acquire({ clientKey: "d", clientLimit: 0 }), /Timed out/);
    release(); release();
    assert.equal(admission.snapshot().active, 0);
    assert.equal(admission.snapshot().queued, 0);
    admission.close();
  });

  it("serializes only an explicitly shared session", async () => {
    const admission = new RequestAdmission({ maxConcurrent: 4, maxQueued: 4, waitTimeoutMs: 1000 });
    const release = await admission.acquire({ clientKey: "a", clientLimit: 0, sessionKey: "same" });
    let ready = false;
    const next = admission.acquire({ clientKey: "a", clientLimit: 0, sessionKey: "same" }).then((r) => { ready = true; return r; });
    const other = await admission.acquire({ clientKey: "a", clientLimit: 0, sessionKey: "other" });
    assert.equal(ready, false);
    release(); (await next)(); other();
    admission.close();
  });
});

describe("20-account scheduling", () => {
  it("fills 20 accounts fairly, caps each account and resumes on lease release", async () => {
    const accounts = pool();
    try {
      const first = Array.from({ length: 20 }, () => accounts.leaseKey("claude-opus-5-5"));
      assert.equal(new Set(first.map((l) => l.slotId)).size, 20);
      const second = Array.from({ length: 20 }, () => accounts.leaseKey("quick-smart"));
      assert.ok(accounts.statusSnapshot().every((s) => s.activeInflight === 2));
      assert.throws(() => accounts.leaseKey(), /busy/);
      const waiting = accounts.acquireKey();
      first[0]!.release();
      const next = await waiting;
      assert.equal(next.slotId, first[0]!.slotId);
      next.release();
      for (const lease of [...first, ...second]) lease.release();
      assert.ok(accounts.statusSnapshot().every((s) => s.activeInflight === 0));
    } finally { accounts.close(); }
  });

  it("does not send requests to cooling accounts and cancels account waits", async () => {
    const accounts = pool(1, { QUEUE_WAIT_TIMEOUT_MS: "100" });
    try {
      accounts.reportRateLimit("test-account-0");
      assert.throws(() => accounts.leaseKey(), /cooling/);
      const controller = new AbortController();
      const waiting = accounts.acquireKey("quick-smart", undefined, undefined, controller.signal);
      const rejection = assert.rejects(waiting, /canceled/);
      controller.abort();
      await rejection;
      assert.equal(accounts.statusSnapshot()[0]!.activeInflight, 0);
    } finally { accounts.close(); }
  });

  it("preserves a busy pinned account rather than breaking conversation affinity", async () => {
    const accounts = pool(2, { SESSION_AFFINITY_ENABLED: "true", ACCOUNT_MAX_CONCURRENT: "1" });
    try {
      const first = accounts.leaseKey("quick-smart", undefined, "thread");
      assert.throws(() => accounts.leaseKey("quick-smart", undefined, "thread"), /Pinned/);
      const other = accounts.leaseKey("quick-smart", undefined, "different");
      assert.notEqual(first.slotId, other.slotId);
      first.release(); other.release();
    } finally { accounts.close(); }
  });

  it("persists rotated OAuth tokens without changing slot identity or affinity", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quick-pool-"));
    const envFile = path.join(dir, ".env");
    const credential = { region: "us-east-1", issuerUrl: "https://identitycenter.amazonaws.com/test", wsHost: "qbs-cell1234.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      clientId: "client-one", clientSecret: "secret", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1 };
    const old = serializeOAuthCredential(credential);
    writeFileSync(envFile, `QUICK_TOKENS=${old}\n`);
    const accounts = new UpstreamKeyPool(loadConfigFromEnv({ QUICK_TOKENS: old, SESSION_AFFINITY_ENABLED: "true" }, envFile));
    try {
      const lease = accounts.leaseKey("quick-smart", undefined, "thread");
      const id = lease.slotId;
      await persistRefreshedOAuthTokens({ clientId: credential.clientId, wsHost: credential.wsHost,
        accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 12345678 });
      const current = accounts.allManagedKeys()[0]!;
      assert.equal(current.slotId, id);
      assert.equal(computeKeySlotId(current.rawKey), id);
      assert.equal(parseOAuthCredential(current.rawKey)!.refreshToken, "new-refresh");
      assert.ok(readFileSync(envFile, "utf8").includes(current.rawKey));
      lease.release();
      const pinned = accounts.leaseKey("quick-smart", undefined, "thread");
      assert.equal(pinned.slotId, id);
      assert.equal(pinned.viaAffinity, true);
      pinned.release();
      accounts.reportRateLimit(old);
      assert.ok(accounts.statusSnapshot()[0]!.cooldownRemainingMs > 0);
    } finally { accounts.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("HTTP protocol routing contracts", () => {
  it("toggles thinking visibility for JSON and SSE in every protocol without changing upstream effort", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quick-thinking-"));
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, "GATEWAY_TOKEN=test-key\nSHOW_THINKING_CONTENT=false\n");
    const config = loadConfigFromEnv({ GATEWAY_TOKEN: "test-key", ADMIN_PASSWORD: "test-admin", QUICK_TOKENS: "test-account", DATA_DIR: dir });
    config.envFilePath = envPath;
    const seen: ParsedProtocolTurn[] = [];
    const instance = createGatewayServer({ config, turnExecutor: async function* (turn) {
      seen.push(turn);
      yield { type: "thinking", text: "TEST_UPSTREAM_THINKING" };
      yield { type: "text", text: "PONG" };
      yield { type: "done", stopReason: "stop" };
    } });
    await new Promise<void>((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(instance.server.address() as { port: number }).port}`;
    try {
      for (const visible of [false, true, false]) {
        const setting = await fetch(base+"/v1/admin/settings", { method: "POST", headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: JSON.stringify({ showThinkingContent: visible }) });
        assert.equal(setting.status, 200);
        assert.match(readFileSync(envPath, "utf8"), new RegExp(`SHOW_THINKING_CONTENT=${visible}`));
        assert.equal(loadConfigFromEnv({ SHOW_THINKING_CONTENT: String(!visible), QUICK_TOKENS: "test-account" }, envPath).showThinkingContent, visible);
        for (const [route, payload] of [["messages", { max_tokens: 100, messages: [{ role: "user", content: "hello" }] }],
          ["chat/completions", { messages: [{ role: "user", content: "hello" }] }], ["responses", { input: "hello" }]] as const) {
          for (const stream of [false, true]) {
            const response = await fetch(`${base}/v1/${route}`, { method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5-thinking", ...payload, stream }) });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-quick-thinking-effort"), "high");
            assert.equal(response.headers.get("x-quick-thinking-visible"), String(visible));
            const text = await response.text();
            assert.equal(text.includes("TEST_UPSTREAM_THINKING"), visible);
            assert.ok(text.includes("PONG"));
            assert.equal(seen.at(-1)!.modelRoute!.thinkingEffort, "high");
          }
        }
      }
      const usage = await fetch(base+"/v1/usage", { headers: { Authorization: "Bearer test-admin" } });
      assert.equal(((await usage.json()) as { settings: { showThinkingContent: boolean } }).settings.showThinkingContent, false);
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("routes all three protocols, preserves aliases and emits matching SSE", async () => {
    const seen: ParsedProtocolTurn[] = [];
    const instance = createGatewayServer({ config: loadConfigFromEnv({ GATEWAY_TOKEN: "test-key", ENABLE_DASHBOARD: "false", QUICK_TOKENS: "test-account" }),
      turnExecutor: async function* (turn): AsyncGenerator<GatewayStreamEvent, void, unknown> {
        seen.push(turn);
        yield { type: "text", text: "PONG" };
        yield { type: "usage", metrics: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, resolvedModel: turn.modelRoute?.observedModel } };
        yield { type: "done", stopReason: "stop" };
      } });
    await new Promise<void>((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
    const port = (instance.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const listed = await fetch(base+"/v1/models", { headers: { Authorization: "Bearer test-key" } });
      const catalog = await listed.json() as { data: Array<{id: string}> };
      assert.deepEqual(catalog.data.map((m) => m.id), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5-think", "claude-opus-5-5", "claude-opus-5-5-think"]);
      for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
        for (const [route, body] of [["chat/completions", { messages: [{ role: "user", content: "hello" }], reasoning_effort: "high" }],
          ["responses", { input: "hello", reasoning: { effort: "high" } }],
          ["messages", { messages: [{ role: "user", content: "hello" }], max_tokens: 100, output_config: { effort: "high" }, thinking: { type: "adaptive" } }]] as const) {
          for (const stream of [false, true]) {
            const response = await fetch(`${base}/v1/${route}`, { method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, model, stream }) });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-quick-agent-mode"), resolveModelRoute(model).agentMode);
            const text = await response.text();
            assert.ok(text.includes("PONG"));
            if (stream) assert.match(text, /data:/);
            assert.equal(seen.at(-1)!.modelRoute!.canonicalModel, model);
            assert.equal(seen.at(-1)!.modelRoute!.thinkingEffort, model.includes("haiku") ? "off" : "high");
          }
        }
      }
      const unknown = await fetch(base+"/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-99", messages: [{ role: "user", content: "hello" }] }) });
      assert.equal(unknown.status, 404);
      assert.equal(instance.admission.snapshot().active, 0);
    } finally { await instance.close(); }
  });

  it("releases inference admission when an SSE client disconnects", async () => {
    let finished = false;
    const instance = createGatewayServer({ config: loadConfigFromEnv({ GATEWAY_TOKEN: "test-key", ENABLE_DASHBOARD: "false", GLOBAL_MAX_CONCURRENT: "1" }),
      turnExecutor: async function* (turn): AsyncGenerator<GatewayStreamEvent, void, unknown> {
        try {
          yield { type: "text", text: "first" };
          await new Promise<void>((resolve) => {
            if (turn.signal?.aborted) resolve();
            else turn.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally { finished = true; }
      } });
    await new Promise<void>((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
    const port = (instance.server.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", signal: controller.signal,
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "quick-fast", stream: true, messages: [{ role: "user", content: "hello" }] }) });
      await response.body!.getReader().read();
      controller.abort();
      for (let attempt = 0; attempt < 100 && !finished; attempt++) await delay(5);
      assert.equal(finished, true);
      assert.equal(instance.admission.snapshot().active, 0);
    } finally { await instance.close(); }
  });
});

import assert from "node:assert/strict";
import type http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { parseOAuthCredential } from "../src/aws-quick/oauth-client.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { UpstreamKeyPool } from "../src/core/key-pool.js";
import { parseYuanzhangJson } from "../src/services/yuanzhang-import.js";
import { createGatewayServer } from "../src/server.js";
import { AdminAuthManager } from "../src/web/admin-auth.js";
import { tryHandleWebAdminRoute, type WebAdminContext } from "../src/web/admin-routes.js";
import { localizeAdminMessage } from "../src/web/admin-i18n.js";
import { renderDashboardHtml } from "../src/web/dashboard-ui.js";

function account(id = "one", disabled = false) {
  return {
    id, label: `测试 ${id}`, disabled, priority: 10, groups: ["external"], proxy_mode: "global",
    session: { jwt: `old-access-${id}`, id_token: `old-id-${id}`,
      ws_host: "qbs-cell-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      aws_account_id: "123456789012", usable_until: 1700000000 },
    upstream: {
      region: "us-east-1", tenant_url: "https://qbs-cell-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      tokens: { access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600 },
      client: { client_id: `client-${id}`, client_secret: `secret-${id}`, idc_region: "us-east-1",
        issuer_url: "https://identitycenter.amazonaws.com/ssoins-test" },
      user_info: { email: `${id}@example.com`, display_name: `用户 ${id}`, aws_account_id: "123456789012" },
    },
  };
}

function harness(envFilePath?: string) {
  const config = loadConfigFromEnv({ ADMIN_PASSWORD: "test-admin", QUICK_TOKENS: "existing-token" }, envFilePath);
  const pool = new UpstreamKeyPool(config);
  const auth = new AdminAuthManager(config);
  const token = auth.verifyPasswordAndIssueSession("test-admin").token;
  const syncs: unknown[] = [];
  const ctx = { config, keyPool: pool, adminAuth: auth,
    extractClientCredential: (req: http.IncomingMessage) => req.headers.authorization?.slice(7) || "",
    syncKeyQuotas: async (opts: unknown) => { syncs.push(opts); return []; },
  } as unknown as WebAdminContext;
  async function request(body: unknown, route = "/v1/admin/keys/import-yuanzhang-json", authorized = true) {
    let response: any;
    const req = { method: "POST", headers: authorized ? { authorization: `Bearer ${token}` } : {},
      socket: { remoteAddress: "127.0.0.1" } } as http.IncomingMessage;
    const requestCtx = { ...ctx, readJsonBody: async () => body,
      sendJson: (_res: http.ServerResponse, status: number, payload: unknown) => { response = { status, payload }; } };
    await tryHandleWebAdminRoute(req, {} as http.ServerResponse, route, new AbortController().signal, requestCtx);
    return response;
  }
  return { pool, request, syncs, ctx };
}

describe("Explicit yuanzhang JSON import", () => {
  it("converts nested OAuth fields and keeps source labels, identities and disabled state", () => {
    const [entry] = parseYuanzhangJson({ version: 1, accounts: [account("one", true)] });
    assert.equal(entry!.enabled, false);
    assert.equal(entry!.label, "测试 one");
    const credential = parseOAuthCredential(entry!.apiKey)!;
    assert.equal(credential.email, "one@example.com");
    assert.equal(credential.name, "用户 one");
    assert.equal(credential.accountId, "123456789012");
    assert.equal(credential.clientId, "client-one");
    assert.equal(credential.refreshToken, "refresh-one");
    assert.equal(credential.accessToken, "access-one");
    assert.equal(credential.expiresAt, 1700000000000);
    assert.equal(entry!.proxyUrl, undefined);
  });

  it("accepts string user_info, tenant host fallback and missing access-token expiry", () => {
    const a: any = account();
    a.upstream.user_info = JSON.stringify(a.upstream.user_info);
    delete a.session.ws_host;
    delete a.session.usable_until;
    delete a.upstream.tokens.access_token;
    const credential = parseOAuthCredential(parseYuanzhangJson({ accounts: [a] })[0]!.apiKey)!;
    assert.equal(credential.email, "one@example.com");
    assert.equal(credential.wsHost, "qbs-cell-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev");
    assert.equal(credential.expiresAt, undefined);
    assert.equal(credential.accessToken, "old-access-one");
  });

  it("validates explicit proxies and ignores dormant URLs in global mode", () => {
    const a: any = account();
    a.proxy_url = "http://proxy.example.com:8080";
    a.proxy_username = "user@tenant"; a.proxy_password = "p:a/ss";
    assert.equal(parseYuanzhangJson({ accounts: [a] })[0]!.proxyUrl, undefined);
    a.proxy_mode = "custom";
    const proxy = new URL(parseYuanzhangJson({ accounts: [a] })[0]!.proxyUrl!);
    assert.equal(decodeURIComponent(proxy.username), "user@tenant");
    assert.equal(decodeURIComponent(proxy.password), "p:a/ss");
    a.proxy_url = "ftp://proxy.example.com";
    assert.throws(() => parseYuanzhangJson({ accounts: [a] }), /accounts\[0\]\.proxy_url/);
  });

  it("rejects malformed fields without including secret values in errors", () => {
    for (const body of [null, [], {}, { accounts: [] }, { accounts: [null] }]) {
      assert.throws(() => parseYuanzhangJson(body));
    }
    for (const mutate of [
      (a: any) => { a.upstream.tokens.refresh_token = ""; },
      (a: any) => { a.upstream.client.client_secret = false; },
      (a: any) => { a.session.ws_host = "https://private-secret.invalid"; },
      (a: any) => { a.upstream.client.idc_region = "us-east-1/private-secret"; },
      (a: any) => { a.upstream.user_info = "private-secret"; },
      (a: any) => { a.disabled = "false"; },
      (a: any) => { a.session.usable_until = -1; },
    ]) {
      const a = account(); mutate(a);
      assert.throws(() => parseYuanzhangJson({ accounts: [a] }), (err: any) => {
        assert.equal(err.status, 400);
        assert.ok(err.message.startsWith("Invalid yuanzhang JSON field:"));
        assert.ok(!err.message.includes("private-secret"));
        assert.match(localizeAdminMessage(err.message, "zh"), /字段缺失或格式无效/);
        return true;
      });
    }
  });

  it("requires explicit selection: the native import endpoint does not detect accounts", async () => {
    const h = harness();
    try {
      await assert.rejects(h.request({ accounts: [account()] }, "/v1/admin/keys/import-json"), /credentials.*array required/);
      assert.equal(h.pool.allManagedKeys().length, 1);
      const native = await h.request([{ apiKey: "native-token", enabled: false }], "/v1/admin/keys/import-json");
      assert.equal(native.payload.imported, 1);
      assert.equal(h.pool.allManagedKeys().find(s => s.rawKey === "native-token")!.enabled, false);
    } finally { h.pool.close(); }
  });

  it("checks the entire batch before writing and authenticates the new endpoint", async () => {
    const h = harness();
    try {
      await assert.rejects(h.request({ accounts: [account()] }, undefined, false), (e: any) => e.status === 401);
      const invalid: any = account("bad"); delete invalid.upstream.tokens.refresh_token;
      await assert.rejects(h.request({ accounts: [account(), invalid] }), /accounts\[1\]/);
      assert.equal(h.pool.allManagedKeys().length, 1);
      assert.equal(h.syncs.length, 0);
    } finally { h.pool.close(); }
  });

  it("imports, deduplicates, persists and synchronizes only new enabled slots", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yuanzhang-import-"));
    const env = path.join(dir, ".env");
    writeFileSync(env, "# isolated test pool\n");
    const h = harness(env);
    let reloaded: UpstreamKeyPool | undefined;
    try {
      const originalSettings = h.pool.getSettings();
      const response = await h.request({ accounts: [account(), account(), account("two", true)] });
      assert.equal(response.payload.format, "yuanzhang");
      assert.equal(response.payload.imported, 2); assert.equal(response.payload.skipped, 1);
      assert.equal(h.syncs.length, 1);
      const active = h.pool.allManagedKeys().find(s => s.label === "测试 one")!;
      assert.deepEqual(h.syncs[0], { slotIds: [active.slotId] });
      assert.deepEqual(h.pool.getSettings(), originalSettings);
      assert.ok(h.pool.allManagedKeys().some(s => s.rawKey === "existing-token"));
      reloaded = new UpstreamKeyPool(loadConfigFromEnv({}, env));
      assert.equal(reloaded.allManagedKeys().length, 3);
      assert.equal(reloaded.allManagedKeys().find(s => s.label === "测试 two")!.enabled, false);
      const result = await h.request({ accounts: [account(), account("two", true)] });
      assert.equal(result.payload.imported, 0); assert.equal(result.payload.skipped, 2);
      assert.equal(h.syncs.length, 1);
    } finally { reloaded?.close(); h.pool.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("never overwrites rotated OAuth credentials or manual state with an old backup", async () => {
    const h = harness();
    try {
      const current = account("current", true);
      const old = structuredClone(current); old.disabled = false;
      current.upstream.tokens.refresh_token = "rotated-refresh";
      const entry = parseYuanzhangJson({ accounts: [current] })[0]!;
      h.pool.addKey(entry.apiKey, false, "manual label");
      const result = await h.request({ accounts: [old] });
      assert.equal(result.payload.skipped, 1);
      const saved = h.pool.allManagedKeys().find(s => s.label === "manual label")!;
      assert.equal(saved.enabled, false);
      assert.equal(parseOAuthCredential(saved.rawKey)!.refreshToken, "rotated-refresh");
      assert.equal(h.syncs.length, 0);
    } finally { h.pool.close(); }
  });

  it("keeps imported accounts when optional quota synchronization fails", async () => {
    const h = harness();
    h.ctx.syncKeyQuotas = async () => { throw Error("temporary quota outage"); };
    try {
      const result = await h.request({ accounts: [account()] });
      assert.equal(result.status, 200); assert.equal(result.payload.imported, 1);
      assert.equal(h.pool.allManagedKeys().length, 2);
    } finally { h.pool.close(); }
  });

  it("serves the explicit endpoint over HTTP without enabling native auto-detection", async () => {
    const gateway = createGatewayServer({ config: loadConfigFromEnv({ ADMIN_PASSWORD: "test-admin",
      DISABLED_QUICK_TOKENS: "standby-test", QUICK_TOKENS: "", ENABLE_DASHBOARD: "true" }) });
    await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(base + "/v1/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-admin" }) });
      const token = (await login.json() as { token: string }).token;
      const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
      const body = JSON.stringify({ accounts: [account("http", true)] });
      const native = await fetch(base + "/v1/admin/keys/import-json", { method: "POST", headers, body });
      assert.equal(native.status, 400);
      await native.json();
      const imported = await fetch(base + "/v1/admin/keys/import-yuanzhang-json", { method: "POST", headers, body });
      assert.equal(imported.status, 200);
      const result = await imported.json() as { imported: number; keyPool: { enabled: boolean }[] };
      assert.equal(result.imported, 1);
      assert.equal(result.keyPool.length, 2);
      assert.ok(result.keyPool.every(s => !s.enabled));
      assert.equal((await fetch(base + "/health")).status, 200);
    } finally { await gateway.close(); }
  });
});

describe("yuanzhang format selector", () => {
  it("defaults and resets to native, changing endpoint and count only after explicit selection", () => {
    const html = renderDashboardHtml("/dashboard", "test-nonce");
    assert.match(html, /<option value="native" selected>/);
    assert.match(html, /<option value="yuanzhang">yuanzhang JSON 格式/);
    const script = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const start = script.indexOf("function batchJsonFormat()");
    const end = script.indexOf('let activeAddMode = "oauth"', start);
    const fields: Record<string, any> = { batchJsonFormatSelect: { value: "native" }, batchJsonFormatHint: {}, modalBatchJsonInput: {} };
    const context = vm.createContext({ $: (id: string) => fields[id], tr: (zh: string) => zh, syncSelectUi: () => {} });
    vm.runInContext(script.slice(start, end), context);
    assert.equal(vm.runInContext("batchJsonEndpoint()", context), "/v1/admin/keys/import-json");
    assert.equal(vm.runInContext("batchJsonCount({accounts:[1,2]})", context), 0);
    fields.batchJsonFormatSelect.value = "yuanzhang"; fields.batchJsonFormatSelect.onchange();
    assert.match(fields.batchJsonFormatHint.textContent, /yuanzhang/);
    assert.equal(vm.runInContext("batchJsonEndpoint()", context), "/v1/admin/keys/import-yuanzhang-json");
    assert.equal(vm.runInContext("batchJsonCount({accounts:[1,2]})", context), 2);
    vm.runInContext("resetBatchJsonFormat()", context);
    assert.equal(fields.batchJsonFormatSelect.value, "native");
    assert.equal(vm.runInContext("batchJsonCount({credentials:[1]})", context), 1);
    assert.doesNotThrow(() => new vm.Script(script));
  });

  it("uses the selected format for uploaded files and pasted JSON and does not submit invalid JSON", async () => {
    const html = renderDashboardHtml("/dashboard", "test-nonce");
    const script = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const fields: Record<string, any> = { batchJsonFormatSelect: { value: "native" }, batchJsonFormatHint: {},
      modalBatchJsonInput: { value: "" }, batchFileStatusLabel: {}, importJsonFileBtn: {}, importJsonFileInput: {}, confirmAddKeyBtn: {} };
    const requests: { path: string; body: any }[] = [];
    const notices: string[] = [];
    const reloads: string[] = [];
    const context = vm.createContext({ $: (id: string) => fields[id], tr: (zh: string) => zh,
      syncSelectUi: () => {}, activeAddMode: "batch", closeAddModal: () => {},
      loadConsoleData: async (suffix: string) => { reloads.push(suffix); }, notify: (message: string) => notices.push(message),
      api: async (path: string, opts: any) => { requests.push({ path, body: JSON.parse(opts.body) }); return { imported: 1, skipped: 2 }; } });
    const a = script.indexOf("function batchJsonFormat()");
    vm.runInContext(script.slice(a, script.indexOf('let activeAddMode = "oauth"', a)), context);
    const b = script.indexOf('if ($("importJsonFileBtn") && $("importJsonFileInput"))');
    vm.runInContext(script.slice(b, script.indexOf('if ($("credClearSessionsBtn"))', b)), context);

    fields.modalBatchJsonInput.value = '[{"apiKey":"native-test"}]';
    await fields.confirmAddKeyBtn.onclick();
    assert.equal(requests[0]!.path, "/v1/admin/keys/import-json");
    assert.equal(reloads[0], "?force=1");
    fields.batchJsonFormatSelect.value = "yuanzhang";
    const payload = { accounts: [account()] };
    await fields.importJsonFileInput.onchange({ target: { files: [{ name: "yuanzhang.json", text: async () => JSON.stringify(payload) }] } });
    assert.match(fields.batchFileStatusLabel.textContent, /1 条凭证/);
    assert.equal(requests.length, 1, "loading a file must wait for confirmation");
    await fields.confirmAddKeyBtn.onclick();
    assert.equal(requests[1]!.path, "/v1/admin/keys/import-yuanzhang-json");
    assert.deepEqual(requests[1]!.body, payload);
    assert.equal(reloads[1], "", "yuanzhang import must not force-refresh the entire existing pool");
    assert.ok(notices.some(n => n.includes("跳过 2 条重复凭证")));

    fields.modalBatchJsonInput.value = JSON.stringify(payload);
    await fields.confirmAddKeyBtn.onclick();
    assert.equal(requests[2]!.path, "/v1/admin/keys/import-yuanzhang-json");
    fields.modalBatchJsonInput.value = "invalid JSON";
    await fields.confirmAddKeyBtn.onclick();
    assert.equal(requests.length, 3);
    assert.equal(fields.confirmAddKeyBtn.disabled, false);
    assert.ok(notices.some(n => n.includes("内容不是有效的 JSON")));
  });
});

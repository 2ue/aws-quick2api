import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uploadImageAttachment } from "../src/aws-quick/attachment-upload.js";
import { toolContract } from "../src/core/tool-contract.js";
import { buildClientToolReminder, buildToolBridgePrompt } from "../src/core/tool-bridge.js";
import { parseAnthropicMessagesRequest } from "../src/protocols/anthropic.js";
import { QuickExecutionEngine, workingSessionIdForThread } from "../src/core/engine.js";
import { loadConfigFromEnv } from "../src/core/config.js";
import { UpstreamKeyPool } from "../src/core/key-pool.js";
import { GatewayError } from "../src/core/types.js";
import { UsageTracker } from "../src/services/usage-tracker.js";

describe("Native attachment delivery", () => {
  it("uploads original bytes, checks verdict, and delivers a path reference", async () => {
    const bytes = Buffer.from("original image payload");
    const calls: string[] = [];
    const attachment = await uploadImageAttachment({
      credential: { clientId: "client", clientSecret: "secret", refreshToken: "refresh", wsHost: "cell.plato.ai.aws.dev", issuerUrl: "", region: "us-east-1" },
      accessToken: "access", threadId: "thread", workingSessionId: "session", outpostId: "outpost", name: "image.png", mimeType: "image/png", bytes,
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith("upload-attachment")) {
          assert.equal(url.searchParams.get("contentLength"), String(bytes.length));
          assert.deepEqual(Buffer.from(init!.body as Uint8Array), bytes);
          return Response.json({ attachmentId: "attached" });
        }
        if (url.pathname.endsWith("attachment-dlp-status")) return Response.json({ dlpJobStatus: "COMPLETED", policyAction: "ALLOW" });
        const body = JSON.parse(init!.body as string);
        assert.equal(body.eventBody.invokeAgent.path, "files/upload/thread");
        return Response.json({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { files: [{ path: "/files/image.png" }] } } } } });
      },
    });
    assert.equal(attachment.path, "/files/image.png");
    assert.equal(attachment.size, bytes.length);
    assert.equal("data" in attachment, false);
    assert.equal(calls.length, 3);
  });

  it("does not deliver an attachment when scanning blocks it", async () => {
    let delivered = false;
    await assert.rejects(uploadImageAttachment({
      credential: { clientId: "client", clientSecret: "secret", refreshToken: "refresh", wsHost: "cell.plato.ai.aws.dev", issuerUrl: "", region: "us-east-1" },
      accessToken: "access", threadId: "thread", workingSessionId: "session", outpostId: "outpost", name: "image.png", mimeType: "image/png", bytes: Buffer.from("payload"),
      fetcher: async (input) => {
        if (String(input).includes("upload-attachment?")) return Response.json({ attachmentId: "a" });
        if (String(input).includes("attachment-dlp-status?")) return Response.json({ policyAction: "WARN" });
        delivered = true;
        return Response.json({});
      },
    }), /did not allow/);
    assert.equal(delivered, false);
  });
});

describe("Client tool contracts", () => {
  const tools = [{ name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }];
  it("checks declared function names, argument schemas, choice and parallel limits", () => {
    const valid = { id: "call", name: "read_file", argumentsJson: '{"path":"a"}', argsObject: { path: "a" } };
    const validate = toolContract(tools, "required", false);
    assert.doesNotThrow(() => validate([valid]));
    assert.throws(() => validate([]));
    assert.throws(() => validate([valid, valid]));
    assert.throws(() => validate([{ ...valid, name: "execute" }]));
    assert.throws(() => validate([{ ...valid, argsObject: { path: 1 } }]));
    assert.throws(() => toolContract([{ name: "remote", inputSchema: { $ref: "https://example.com/schema" } }], "auto", true));
  });

  it("accepts Claude Code 2020-12 schemas and enforces their native constraints", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { type: "string" },
        bounds: { type: "array", prefixItems: [{ type: "integer" }, { type: "string" }], items: false },
      },
      required: ["command"],
      unevaluatedProperties: false,
    };
    const validate = toolContract([{ name: "Bash", inputSchema: schema }], "auto", true);
    const call = (argsObject: Record<string, unknown>) => ({ id: "call", name: "Bash", argsObject, argumentsJson: JSON.stringify(argsObject) });
    assert.doesNotThrow(() => validate([call({ command: "printf test", bounds: [2, "end"] })]));
    assert.throws(() => validate([call({ command: "printf test", extra: true })]));
    assert.throws(() => validate([call({ command: "printf test", bounds: ["wrong", "end"] })]));
    assert.throws(() => validate([call({ command: "printf test", bounds: [2, "end", 3] })]));
  });

  it("supports 2019-09 schemas without weakening references or legacy schemas", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object", $defs: { path: { type: "string", minLength: 1 } },
      properties: { path: { $ref: "#/$defs/path" } }, required: ["path"], unevaluatedProperties: false,
    };
    const validate = toolContract([{ name: "Read", inputSchema: schema }], "auto", true);
    assert.doesNotThrow(() => validate([{ id: "call", name: "Read", argsObject: { path: "probe.txt" }, argumentsJson: '{"path":"probe.txt"}' }]));
    assert.throws(() => validate([{ id: "call", name: "Read", argsObject: { path: "" }, argumentsJson: '{"path":""}' }]));
    assert.throws(() => toolContract([{ name: "remote", inputSchema: { ...schema, $ref: "https://example.com/schema" } }], "auto", true));
  });
});

describe("Claude Code deferred MCP tools", () => {
  it("preserves the deferred catalog as system context without changing the user turn", () => {
    const turn = parseAnthropicMessagesRequest({
      model: "claude-sonnet-5-5", max_tokens: 1000, system: "Client system rules.",
      messages: [
        { role: "user", content: "Look up a private record." },
        { role: "system", content: [{ type: "text", text: "Deferred tools available via ToolSearch: mcp__demo__lookup" }] },
      ],
      tools: [
        { name: "DeferredToolPlaceholder", defer_loading: true, input_schema: { type: "object" } },
        { name: "ToolSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      ],
    });
    assert.equal(turn.fullTranscriptText, "Look up a private record.");
    assert.equal(turn.systemPrompt, "Client system rules.\n\nDeferred tools available via ToolSearch: mcp__demo__lookup");
    assert.deepEqual(turn.tools.map((tool) => tool.name), ["ToolSearch"]);
    const prompt = buildToolBridgePrompt(turn.tools, "auto");
    assert.match(prompt, /first invoke ToolSearch/);
    assert.match(prompt, /max_results=5/);
    assert.match(prompt, /missing Quick connector does not mean/);
    assert.match(buildClientToolReminder(turn.tools, "auto"), /not the Quick cloud workspace/);
    assert.equal(buildClientToolReminder(turn.tools, "none"), "");
  });

  it("loads deferred schemas referenced by ToolSearch and preserves the result across system metadata", () => {
    const body = {
      model: "claude-sonnet-5-5", max_tokens: 1000,
      messages: [
        { role: "user", content: "Look up record 42." },
        { role: "assistant", content: [{ type: "tool_use", id: "search", name: "ToolSearch", input: { query: "select:mcp__demo__lookup" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "search", content: [{ type: "tool_reference", tool_name: "mcp__demo__lookup" }] }, { type: "text", text: "Tool loaded." }] },
        { role: "system", content: "Remaining budget: 1000." },
      ],
      tools: [
        { name: "ToolSearch", input_schema: { type: "object" } },
        { name: "mcp__demo__lookup", defer_loading: true, input_schema: { type: "object", properties: { id: { type: "string" } } } },
      ],
    };
    const turn = parseAnthropicMessagesRequest(body);
    assert.deepEqual(turn.tools.map((tool) => tool.name), ["ToolSearch", "mcp__demo__lookup"]);
    assert.match(turn.fullTranscriptText, /CLIENT_TOOL_LOADED.*mcp__demo__lookup/);
    assert.equal(turn.trailingToolResults[0].toolCallId, "search");
    assert.equal(turn.trailingUserText, "Tool loaded.");
    assert.throws(() => parseAnthropicMessagesRequest({ ...body, tools: body.tools.slice(0, 1) }), /missing its schema/);
  });
});

describe("Upstream connection isolation", () => {
  it("gives separate threads on the same account separate working sessions, retaining warm continuity", () => {
    const first = workingSessionIdForThread("client-a", "account", "thread-a");
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(first, workingSessionIdForThread("client-a", "account", "thread-a"));
    assert.notEqual(first, workingSessionIdForThread("client-a", "account", "thread-b"));
    assert.notEqual(first, workingSessionIdForThread("client-b", "account", "thread-a"));
    assert.notEqual(first, workingSessionIdForThread("client-a", "other-account", "thread-a"));
  });

  it("does not cool down a healthy account when generated tool arguments fail validation", async () => {
    const config = loadConfigFromEnv({ QUICK_TOKENS: "test-account", SESSION_AFFINITY_ENABLED: "false" });
    const pool = new UpstreamKeyPool(config);
    const engine = new QuickExecutionEngine({ config, usageTracker: new UsageTracker() });
    Object.assign(engine, { executeTurnWithLease: async function* () {
      throw new GatewayError("Invalid generated tool arguments.", 502, "invalid_tool_call");
    } });
    const turn = parseAnthropicMessagesRequest({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Run a tool." }] });
    try {
      await assert.rejects(async () => { for await (const _ of engine.executeTurnWithPool(turn, pool)) { /* drain */ } }, /Invalid generated tool/);
      const state = pool.statusSnapshot()[0];
      assert.equal(state.activeInflight, 0);
      assert.equal(state.cooldownRemainingMs, 0);
      assert.equal(state.enabled, true);
    } finally {
      pool.close();
    }
  });
});

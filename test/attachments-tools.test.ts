import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uploadImageAttachment } from "../src/aws-quick/attachment-upload.js";
import { toolContract } from "../src/core/tool-contract.js";

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
});

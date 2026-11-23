import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential } from "./oauth-client.js";
import { GatewayError } from "../core/types.js";
import { fetchViaOptionalProxy } from "../utils/proxy-agent.js";

export interface NativeAttachment {
  type: "image";
  name: string;
  size: number;
  mimeType: string;
  contentSha256: string;
  path: string;
  attachmentId: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function uploadImageAttachment(options: {
  credential: OAuthCredential; accessToken: string; threadId: string; workingSessionId: string; outpostId: string;
  name: string; mimeType: string; bytes: Buffer; signal?: AbortSignal; proxyUrl?: string;
  fetcher?: typeof fetch;
}): Promise<NativeAttachment> {
  const { credential, accessToken, name, mimeType, bytes, signal, proxyUrl } = options;
  const fetcher = options.fetcher ?? ((url: string, init?: RequestInit) => fetchViaOptionalProxy(url, {
    method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body as string | Uint8Array | undefined, signal: init?.signal ?? undefined,
  }, proxyUrl, { maxRetries: 0 }));
  const base = `https://${credential.wsHost}/integration/quick-work/`;
  const headers = { Authorization: `Bearer ${accessToken}`, "x-amzn-qs-internal-trace-id": crypto.randomUUID() };
  async function request(endpoint: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetcher(base+endpoint, { ...init, signal, headers: { ...headers, ...init?.headers } });
    if (!response.ok) throw new GatewayError(`Quick attachment service returned HTTP ${response.status}.`,
      [401, 403, 429].includes(response.status) ? response.status : 502, "attachment_upload_error");
    return object(await response.json());
  }
  const query = new URLSearchParams({ name, contentType: mimeType, contentLength: String(bytes.length) });
  const uploaded = await request(`upload-attachment?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes) });
  const attachmentId = uploaded.attachmentId;
  if (typeof attachmentId !== "string" || !attachmentId) throw new GatewayError("Quick did not return an attachment ID.", 502, "attachment_upload_error");
  let allowed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (attempt) await delay(1500, undefined, { signal });
    const verdict = await request(`attachment-dlp-status?attachmentId=${encodeURIComponent(attachmentId)}`);
    const action = String(verdict.policyAction || "").toUpperCase();
    const status = String(verdict.dlpJobStatus || "").toUpperCase();
    if (["BLOCK", "WARN", "DENY", "REJECT"].includes(action)) throw new GatewayError("Quick did not allow the attachment.", 400, "attachment_blocked");
    if (action === "ALLOW") { allowed = true; break; }
    if (["FAILED", "ERROR", "COMPLETED"].includes(status)) throw new GatewayError("Quick attachment scan did not allow this file.", 502, "attachment_scan_error");
  }
  if (!allowed) throw new GatewayError("Quick attachment scan timed out.", 504, "attachment_scan_timeout");
  const delivered = await request("qbs-event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    eventType: "invokeAgent", eventBody: { invokeAgent: { path: `files/upload/${options.threadId}`, queryParams: { _method: "POST" },
      body: { attachmentId }, workingSessionId: options.workingSessionId, outpostId: options.outpostId } },
  }) });
  const response = object(object(delivered.eventResponse).invokeAgentResponse);
  const api = Object.keys(object(response.api_response)).length ? object(response.api_response) : response;
  const status = Number(api.status || 200);
  if (status < 200 || status >= 300) throw new GatewayError("Quick did not accept the attachment delivery.", 502, "attachment_delivery_error");
  const body = object(api.body);
  const file = Array.isArray(body.files) ? object(body.files[0]) : {};
  const filePath = body.path || file.path;
  if (typeof filePath !== "string" || !filePath) throw new GatewayError("Quick attachment delivery returned no file path.", 502, "attachment_delivery_error");
  return { type: "image", name, size: bytes.length, mimeType, contentSha256: crypto.createHash("sha256").update(bytes).digest("hex"), path: filePath, attachmentId };
}

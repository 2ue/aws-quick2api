import { GatewayError } from "./types.js";

interface AdmissionRequest {
  clientKey: string;
  clientLimit: number;
  sessionKey?: string;
  signal?: AbortSignal;
}

interface Waiter {
  request: AdmissionRequest;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class RequestAdmission {
  private active = 0;
  private readonly clients = new Map<string, number>();
  private readonly sessions = new Set<string>();
  private readonly waiting: Waiter[] = [];
  private closed = false;

  constructor(private readonly limits: { maxConcurrent: number; maxQueued: number; waitTimeoutMs: number }) {}

  activeForKey(key: string): number { return this.clients.get(key) ?? 0; }

  snapshot() {
    return { active: this.active, queued: this.waiting.length, maxConcurrent: this.limits.maxConcurrent,
      maxQueued: this.limits.maxQueued, waitTimeoutMs: this.limits.waitTimeoutMs, lockedSessions: this.sessions.size };
  }

  private canRun(request: AdmissionRequest): boolean {
    return this.active < this.limits.maxConcurrent &&
      (request.clientLimit <= 0 || this.activeForKey(request.clientKey) < request.clientLimit) &&
      (!request.sessionKey || !this.sessions.has(request.sessionKey));
  }

  private grant(request: AdmissionRequest): () => void {
    this.active++;
    this.clients.set(request.clientKey, this.activeForKey(request.clientKey) + 1);
    if (request.sessionKey) this.sessions.add(request.sessionKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const remaining = this.activeForKey(request.clientKey) - 1;
      if (remaining > 0) this.clients.set(request.clientKey, remaining);
      else this.clients.delete(request.clientKey);
      if (request.sessionKey) this.sessions.delete(request.sessionKey);
      this.drain();
    };
  }

  private drain(): void {
    for (let i = 0; i < this.waiting.length && this.active < this.limits.maxConcurrent;) {
      const waiter = this.waiting[i]!;
      if (!this.canRun(waiter.request)) { i++; continue; }
      this.waiting.splice(i, 1);
      waiter.cleanup();
      waiter.resolve(this.grant(waiter.request));
    }
  }

  acquire(request: AdmissionRequest): Promise<() => void> {
    if (this.closed) return Promise.reject(new GatewayError("Gateway is shutting down.", 503, "gateway_closing"));
    if (request.signal?.aborted) return Promise.reject(new GatewayError("Request canceled.", 499, "request_canceled"));
    if (this.canRun(request) && !this.waiting.length) return Promise.resolve(this.grant(request));
    if (this.waiting.length >= this.limits.maxQueued) {
      return Promise.reject(Object.assign(new GatewayError("Gateway request queue is full.", 429, "request_queue_full"), { retryAfter: 2 }));
    }
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiter.cleanup();
        reject(error);
        this.drain();
      };
      const onAbort = () => remove(new GatewayError("Request canceled while queued.", 499, "request_canceled"));
      const timer = setTimeout(() => remove(Object.assign(new GatewayError("Timed out waiting for gateway capacity.", 429, "request_queue_timeout"), { retryAfter: 2 })), this.limits.waitTimeoutMs);
      const waiter: Waiter = { request, resolve, reject, cleanup: () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      } };
      this.waiting.push(waiter);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      else this.drain();
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.cleanup();
      waiter.reject(new GatewayError("Gateway is shutting down.", 503, "gateway_closing"));
    }
  }
}

export function explicitSessionKey(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>): string | undefined {
  for (const name of ["x-session-id", "session-id", "session_id", "x-session-affinity", "x-conversation-id", "x-thread-id", "openai-conversation-id"]) {
    const value = headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (text?.trim()) return text.trim();
  }
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    const metadata = body.metadata as Record<string, unknown>;
    for (const name of ["session_id", "conversation_id"]) {
      if (typeof metadata[name] === "string" && metadata[name].trim()) return metadata[name].trim();
    }
    if (typeof metadata.user_id === "string") {
      try {
        const user = JSON.parse(metadata.user_id);
        if (typeof user.session_id === "string" && user.session_id.trim()) return user.session_id.trim();
      } catch { /* Older clients supply an opaque user ID, which is not a conversation ID. */ }
    }
  }
  return undefined;
}

import { computeKeySlotId, type UpstreamKeyPool } from "../core/key-pool.js";
import { fetchAccountUsageQuota, type QuickPlanQuotaView } from "./quota-service.js";

type Probe = { rawKey: string; apply: (quota?: QuickPlanQuotaView, error?: string) => void; done: () => void; promise: Promise<void> };

/** Request-scoped failures enqueue account-scoped diagnostics, independently of inference leases. */
export class LimitQuotaProbe {
  private readonly pending = new Map<string, Probe>();
  private readonly queue: Probe[] = [];
  private readonly lastAttempt = new Map<string, number>();
  private readonly controllers = new Set<AbortController>();
  private active = 0;
  private closed = false;
  private completed = 0;
  private failed = 0;
  private coalesced = 0;
  private throttled = 0;
  private dropped = 0;

  constructor(private readonly pool: UpstreamKeyPool, private readonly options: {
    fetcher?: typeof fetchAccountUsageQuota;
    maxConcurrent?: number;
    maxQueued?: number;
    minIntervalMs?: number;
    timeoutMs?: number;
  } = {}) {}

  trigger(rawKey: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const id = computeKeySlotId(rawKey);
    const existing = this.pending.get(id);
    if (existing) { this.coalesced++;return existing.promise; }
    if (Date.now() - (this.lastAttempt.get(id) ?? -Infinity) < (this.options.minIntervalMs ?? 60000)) {
      this.throttled++;return Promise.resolve();
    }
    if (this.queue.length >= (this.options.maxQueued ?? 100)) { this.dropped++;return Promise.resolve(); }
    const apply = this.pool.createLimitQuotaUpdater(rawKey);
    if (!apply) return Promise.resolve();
    let done!: () => void;
    const promise = new Promise<void>((resolve) => { done = resolve; });
    const probe = { rawKey, apply, done, promise };
    this.pending.set(id, probe);
    this.queue.push(probe);
    this.pump();
    return promise;
  }

  private pump(): void {
    while (!this.closed && this.active < (this.options.maxConcurrent ?? 2) && this.queue.length) {
      const probe = this.queue.shift()!;
      this.active++;
      this.lastAttempt.set(computeKeySlotId(probe.rawKey), Date.now());
      void this.run(probe).catch(() => undefined);
    }
  }

  private async run(probe: Probe): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Account quota lookup canceled or timed out"));
      controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10000);
    });
    try {
      const current = this.pool.allManagedKeys().find((s) => s.slotId === computeKeySlotId(probe.rawKey));
      if (!current) return;
      const quota = await Promise.race([
        (this.options.fetcher ?? fetchAccountUsageQuota)(current.rawKey, controller.signal, this.pool.proxyUrlForKey(current.rawKey)),
        canceled,
      ]);
      if (!this.closed) { probe.apply(quota);this.completed++; }
    } catch (error) {
      if (!this.closed) { probe.apply(undefined, error instanceof Error ? error.message : "Quota lookup failed");this.failed++; }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      this.controllers.delete(controller);
      this.pending.delete(computeKeySlotId(probe.rawKey));
      this.lastAttempt.set(computeKeySlotId(probe.rawKey), Date.now());
      this.active--;
      probe.done();
      try {
        const managed = new Set(this.pool.allManagedKeys().map((s) => s.slotId));
        for (const id of this.lastAttempt.keys()) if (!managed.has(id)) this.lastAttempt.delete(id);
      } finally { this.pump(); }
    }
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length, completed: this.completed, failed: this.failed,
      coalesced: this.coalesced, throttled: this.throttled, dropped: this.dropped,
      maxConcurrent: this.options.maxConcurrent ?? 2, minIntervalMs: this.options.minIntervalMs ?? 60000, timeoutMs: this.options.timeoutMs ?? 10000 };
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    for (const probe of this.queue.splice(0)) { this.pending.delete(computeKeySlotId(probe.rawKey));probe.done(); }
    this.lastAttempt.clear();
  }
}

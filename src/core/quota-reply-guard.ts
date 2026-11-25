import { GatewayError, type GatewayStreamEvent } from "./types.js";

const LIMIT_REPLIES = [
  "you've reached your usage limit. check your profile for details.",
  "you have reached your usage limit. check your profile for details.",
];

function normalize(text: string): string {
  return text.trimStart().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

/** Hold only a possible platform quota reply until it can be distinguished from actual content. */
export class QuotaReplyGuard {
  private text = "";
  private checking = true;
  private pending: GatewayStreamEvent[] = [];

  feed(event: GatewayStreamEvent, syntheticThinking = false): GatewayStreamEvent[] {
    if (!this.checking) return [event];
    this.pending.push(event);
    if (event.type === "text") {
      this.text += event.text;
      const normalized = normalize(this.text);
      if (this.text.length <= 256 && LIMIT_REPLIES.some((reply) => reply.startsWith(normalized.trimEnd()))) return [];
    } else if (event.type === "usage" && event.metrics.outputTokens <= 1 || event.type === "thinking" && syntheticThinking) {
      return [];
    } else if (event.type === "done") {
      const normalized = normalize(this.text).trimEnd();
      if (/^you(?:'ve| have) reached your usage limit\.\s*check your profile for details\.?$/.test(normalized)) {
        this.pending = [];
        throw new GatewayError("AWS Quick account temporarily reached its usage limit.", 429, "usage_limit_reached");
      }
    }
    this.checking = false;
    const events = this.pending;
    this.pending = [];
    return events;
  }
}

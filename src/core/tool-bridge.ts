import crypto from "node:crypto";
import type { NormalizedTool, NormalizedToolCall, ToolChoiceMode } from "./types.js";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/**
 * Build a concise, unambiguous system instruction block for client-defined tools.
 * Only injected into AWS Quick's `custom_prompt` when `turn.tools.length > 0`.
 */
export function buildToolBridgePrompt(
  tools: readonly NormalizedTool[],
  toolChoice: ToolChoiceMode,
): string {
  if (!tools.length || toolChoice === "none") return "";

  const specs = tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema,
  }));

  const choiceRule =
    toolChoice === "required"
      ? "You MUST call at least one tool from the list below in this turn."
      : typeof toolChoice === "object" && toolChoice.type === "tool"
        ? `You MUST call the tool named "${toolChoice.name}" in this turn.`
        : "Call a tool only when needed to answer the user's request; otherwise respond directly in plain text.";

  return [
    "# External Client Tool Delegation Protocol",
    "The user is connected through an external API client that intercepts `<tool_call>` XML blocks from your text response, executes the requested tool locally on the client side, and sends the real tool result back to you in the next turn.",
    "You are NOT executing these tools inside this environment and you are NOT fabricating results — outputting a `<tool_call>` block is simply how you ask the external client to run one of its tools for you.",
    "Available external client tools:",
    "```json",
    JSON.stringify(specs, null, 2),
    "```",
    choiceRule,
    `To delegate a tool call to the external client, output ONLY one or more ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} blocks containing valid JSON:`,
    `${TOOL_CALL_OPEN}`,
    `{"name": "<tool_name>", "arguments": {<json_arguments>}}`,
    `${TOOL_CALL_CLOSE}`,
    "Do not wrap the XML tags in markdown code fences. After outputting the `<tool_call>` block(s), stop immediately so the client can execute the tool and return the result.",
  ].join("\n");
}

/**
 * Parse `<tool_call>{...}</tool_call>` blocks from model output text.
 */
export function parseToolCallsFromText(text: string): {
  cleanText: string;
  toolCalls: NormalizedToolCall[];
} {
  const toolCalls: NormalizedToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let lastIdx = 0;
  const textParts: string[] = [];

  for (const match of text.matchAll(regex)) {
    const start = match.index ?? 0;
    const rawBlock = (match[1] ?? "").trim();
    textParts.push(text.slice(lastIdx, start));
    lastIdx = start + match[0].length;

    const unfenced = rawBlock
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(unfenced) as Record<string, unknown>;
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!name) continue;
      const rawArgs = parsed.arguments ?? parsed.input ?? {};
      const argsObject: Record<string, unknown> =
        typeof rawArgs === "string"
          ? (() => {
              try {
                const obj = JSON.parse(rawArgs);
                return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
              } catch {
                return {};
              }
            })()
          : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
      const argumentsJson = JSON.stringify(argsObject);
      toolCalls.push({
        id: `call_${crypto.randomBytes(8).toString("hex")}`,
        name,
        argumentsJson,
        argsObject,
      });
    } catch {
      // Malformed JSON inside <tool_call>: preserve raw block as text so nothing is silently lost.
      textParts.push(match[0]);
    }
  }

  textParts.push(text.slice(lastIdx));
  return {
    cleanText: textParts.join("").trim(),
    toolCalls,
  };
}

/**
 * Streaming helper that emits normal text immediately while buffering once `<tool_call` begins.
 * Zero buffering overhead when a response never emits `<tool_call`.
 */
export class StreamingToolCallFilter {
  private pending = "";
  private capturing = false;
  private captured = "";

  feed(delta: string): string {
    if (!delta) return "";
    if (this.capturing) {
      this.captured += delta;
      return "";
    }
    const combined = this.pending + delta;
    const openIdx = combined.indexOf(TOOL_CALL_OPEN);
    if (openIdx !== -1) {
      const before = combined.slice(0, openIdx);
      this.capturing = true;
      this.captured = combined.slice(openIdx);
      this.pending = "";
      return before;
    }

    // Hold back a potential partial prefix of `<tool_call>` at the tail of the chunk.
    let holdLen = 0;
    const maxCheck = Math.min(combined.length, TOOL_CALL_OPEN.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (TOOL_CALL_OPEN.startsWith(combined.slice(combined.length - len))) {
        holdLen = len;
        break;
      }
    }
    this.pending = holdLen > 0 ? combined.slice(combined.length - holdLen) : "";
    return holdLen > 0 ? combined.slice(0, combined.length - holdLen) : combined;
  }

  flush(): { remainingText: string; toolCalls: NormalizedToolCall[] } {
    if (!this.capturing) {
      const rem = this.pending;
      this.pending = "";
      return { remainingText: rem, toolCalls: [] };
    }
    const { cleanText, toolCalls } = parseToolCallsFromText(this.captured);
    this.captured = "";
    this.capturing = false;
    return { remainingText: cleanText, toolCalls };
  }
}

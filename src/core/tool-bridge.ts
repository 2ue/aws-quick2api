import crypto from "node:crypto";
import type { NormalizedTool, NormalizedToolCall, ToolChoiceMode } from "./types.js";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const COMPACT_SCHEMA_TRIGGER_BYTES = 12_000;

function trimText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function compactJsonSchema(node: unknown, maxDescLen: number, depth = 0): unknown {
  if (depth > 8 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => compactJsonSchema(item, maxDescLen, depth + 1));
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$schema" || k === "$id" || k === "title" || k === "examples" || k === "default") continue;
    if (k === "description" && typeof v === "string") {
      if (maxDescLen > 0) out[k] = trimText(v, maxDescLen);
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = compactJsonSchema(pv, maxDescLen, depth + 1);
      }
      out[k] = props;
      continue;
    }
    out[k] = compactJsonSchema(v, maxDescLen, depth + 1);
  }
  return out;
}

/**
 * Soften direct identity-override phrases from third-party CLI/IDE agents (e.g. Claude Code,
 * Codex, Cline, Roo Code, Kilo, Cursor, OpenCode, Hermes) that clash with AWS Quick's built-in
 * identity and trigger false-positive refusals, while preserving all coding rules, workspace
 * paths, and task instructions.
 */
export function sanitizeClientSystemPromptForQuick(systemPrompt: string, hasTools: boolean): string {
  if (!systemPrompt || !hasTools) return systemPrompt;
  return systemPrompt
    .replace(
      /\bYou are (?:Claude Code|Codex|Cline|Roo Code|Roo|Kilo Code|Kilo|Cursor|OpenCode|Hermes)\b[^\n.]*\.?/gi,
      "You are assisting a developer through an external coding client.",
    )
    .replace(
      /\bYou are an interactive CLI tool\b/gi,
      "You are assisting a developer using an interactive CLI client",
    )
    .replace(
      /\bYou are a coding agent running in[^\n.]*\.?/gi,
      "You are assisting a developer working in a local coding environment.",
    );
}

/**
 * Build a compact, unambiguous instruction block for client-defined tools.
 * Kept inside AWS Quick's native `custom_prompt` when `turn.tools.length > 0`.
 */
export function buildToolBridgePrompt(
  tools: readonly NormalizedTool[],
  toolChoice: ToolChoiceMode,
): string {
  if (!tools.length || toolChoice === "none") return "";

  const fullSpecs = tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema,
  }));

  let serialized = JSON.stringify(fullSpecs);
  if (Buffer.byteLength(serialized, "utf8") > COMPACT_SCHEMA_TRIGGER_BYTES) {
    const compactSpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 200) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 100),
    }));
    serialized = JSON.stringify(compactSpecs);
  }
  if (Buffer.byteLength(serialized, "utf8") > 24_000) {
    const minimalSpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 80) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 0),
    }));
    serialized = JSON.stringify(minimalSpecs);
  }

  const choiceRule =
    toolChoice === "required"
      ? "Propose at least one tool action from the list above in this turn."
      : typeof toolChoice === "object" && toolChoice.type === "tool"
        ? `Propose the tool action named "${toolChoice.name}" in this turn.`
        : "Use a client tool action whenever the task needs workspace access, command execution, MCP data, or another capability offered by the client tools. Answer directly only when no such action is needed.";

  return [
    "## Client Tool Action Format",
    "The external client runner executes the tool actions listed below and returns their real results. This client tool catalog is independent of Quick's internal tools and connected sources. Use this bridge for client actions; a missing Quick connector does not mean a client MCP tool is unavailable.",
    "To invoke a client action, output a structured `<tool_call>` JSON block. Do not merely explain how the user could perform the action. Never fabricate tool outputs; wait for the runner's tool result before reporting completion.",
    ...(tools.some((tool) => tool.name === "ToolSearch") ? [
      "For deferred tools, first invoke ToolSearch with query=\"select:<exact_tool_name>\" and max_results=5. Names in the client's deferred-tool catalog are available through that runner even if Quick has no corresponding connector. After ToolSearch returns the schema, invoke the discovered action and continue the task; discovery alone does not complete the requested operation.",
    ] : []),
    "Available client runner actions (JSON):",
    serialized,
    choiceRule,
    `Output format (no markdown code fences around the tags; stop right after the block(s) so the local runner can execute and reply):`,
    `${TOOL_CALL_OPEN}{"name":"<tool_name>","arguments":{...}}${TOOL_CALL_CLOSE}`,
  ].join("\n");
}

export function buildClientToolReminder(tools: readonly NormalizedTool[], choice: ToolChoiceMode): string {
  if (!tools.length || choice === "none") return "";
  return [
    "[External client runner]",
    "The user's workspace and MCP servers belong to the external client, not the Quick cloud workspace. Use the client actions declared in the custom instructions for this task. Quick's files, sandbox, or connector inventory cannot establish whether the client's files or MCP servers exist.",
    `Callable client actions: ${tools.map((tool) => tool.name).join(", ")}.`,
    ...(tools.some((tool) => tool.name === "ToolSearch") ? ["Use ToolSearch to load deferred client tools before invoking them."] : []),
    'Invoke through <tool_call>{"name":"<declared_action>","arguments":{...}}</tool_call> and stop for the real result. Do the requested actions rather than giving instructions; never invent a result.',
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

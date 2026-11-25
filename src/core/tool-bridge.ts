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

export function buildClientCapabilityPrompt(tools: readonly NormalizedTool[], choice: ToolChoiceMode): string {
  const canCallTools = tools.length > 0 && choice !== "none";
  return [
    "## External API Client Session",
    "Respond to the caller's actual request and follow their system instructions, language, requested format and scope. Ordinary conversation, explanations, design discussions, reviews, and requests to show code are valid direct answers; do not turn them into workspace operations unless requested. This session is an API conversation, not the AWS Quick web application.",
    "Quick's built-in workspace, file, artifact, shell and connector tools are not connected to the caller's environment. Do not use those internal tools as a substitute for client actions or deliver inaccessible artifacts such as qw-file:// links. Never claim a local file, command, search or external operation succeeded without its real client tool result.",
    canCallTools
      ? "Use the declared client tools when the task requires acting on the caller's environment or obtaining data from it. Requests to implement, build, fix or extend a project in the workspace imply the necessary inspection, file creation and edits, even when no filenames or tool names are given. Carry out those actions instead of returning only a plan, source listing or completion claim. Inspect existing files with client tools before changing them, preserve unrelated work, and use appropriate available tools; do not assume a particular tool name."
      : "No client tools are callable for this turn. Answer directly with the requested text, code or complete source content. For multi-file code, label each file's path and provide its contents in the response. Do not perform or claim filesystem or MCP access, and do not replace the requested content with a link or a claim that a file was generated. If live environment data is essential, explain the missing capability rather than inventing it.",
    ...(canCallTools ? [
      "For each client action, follow the tool schema and bridge format below, then stop and wait for the actual result. Use successful results as evidence and handle failures as failures; correct recoverable errors without inventing data or claiming success. Continue the remaining task after tool results arrive. A missing Quick connector or an empty Quick cloud directory says nothing about client files or MCP availability.",
      "If the user asks only for an explanation, a plan, a code example, or explicitly says not to change files, respond directly and do not write files. Do not force tool calls for ordinary conversation. Respect tool_choice and any client restrictions on actions or tests.",
    ] : []),
  ].join("\n");
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
    "For workspace implementation tasks, use the declared client read/write/edit/shell actions as appropriate, including all necessary files when the request implies a project. Prefer dedicated file tools when suitable and include complete content in write arguments. A source listing or Quick artifact does not complete a requested workspace change. Requests only to discuss or show code should be answered directly without changing files.",
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
    "Implementing or fixing a project implies the necessary client workspace actions, even without explicit filenames. Use the available client tools and wait for real results; do not substitute Quick internal artifacts or qw-file:// links. Answer ordinary conversation or explanation-only requests directly without changing files.",
    ...(tools.some((tool) => tool.name === "ToolSearch") ? ["Use ToolSearch to load deferred client tools before invoking them."] : []),
    'Invoke through <tool_call>{"name":"<declared_action>","arguments":{...}}</tool_call> and stop for the real result. Do the requested actions rather than giving instructions; never invent a result.',
  ].join("\n");
}

class MarkdownCodeState {
  private fence = "";
  private fenceLength = 0;
  private inlineTicks = 0;
  private delimiter = "";
  private delimiterLength = 0;
  private delimiterAtLineStart = false;
  private lineIndent = 0;
  private lineStart = true;

  get insideCode(): boolean {
    this.finishDelimiter();
    return Boolean(this.fence || this.inlineTicks);
  }

  advance(text: string): void {
    for (const char of text) {
      if (char === "`" || char === "~") {
        if (this.delimiter && this.delimiter !== char) this.finishDelimiter();
        if (!this.delimiter) {
          this.delimiter = char;
          this.delimiterAtLineStart = this.lineStart && this.lineIndent <= 3;
        }
        this.delimiterLength++;
        continue;
      }
      this.finishDelimiter();
      if (char === "\n") {
        this.lineStart = true;
        this.lineIndent = 0;
      } else if (this.lineStart && char === " ") {
        this.lineIndent++;
      } else if (char !== "\r") {
        this.lineStart = false;
      }
    }
  }

  private finishDelimiter(): void {
    if (!this.delimiter) return;
    const char = this.delimiter;
    const size = this.delimiterLength;
    if (this.delimiterAtLineStart && size >= 3 && !this.inlineTicks) {
      if (!this.fence) { this.fence = char; this.fenceLength = size; }
      else if (this.fence === char && size >= this.fenceLength) this.fence = "";
    } else if (!this.fence && char === "`") {
      if (!this.inlineTicks) this.inlineTicks = size;
      else if (this.inlineTicks === size) this.inlineTicks = 0;
    }
    this.lineStart = false;
    this.delimiter = "";
    this.delimiterLength = 0;
  }
}

function toolCallEnd(text: string, from: number): number {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (text.startsWith(TOOL_CALL_CLOSE, i)) return i;
  }
  return -1;
}

export function parseToolCallsFromText(text: string): {
  cleanText: string;
  toolCalls: NormalizedToolCall[];
} {
  const toolCalls: NormalizedToolCall[] = [];
  let lastIdx = 0;
  let searchFrom = 0;
  const textParts: string[] = [];
  const markdown = new MarkdownCodeState();

  while (searchFrom < text.length) {
    const start = text.indexOf(TOOL_CALL_OPEN, searchFrom);
    if (start < 0) break;
    markdown.advance(text.slice(searchFrom, start));
    searchFrom = start + TOOL_CALL_OPEN.length;
    if (markdown.insideCode) {
      markdown.advance(TOOL_CALL_OPEN);
      continue;
    }
    const end = toolCallEnd(text, searchFrom);
    if (end < 0) break;
    const raw = text.slice(start, end + TOOL_CALL_CLOSE.length);
    const rawBlock = text.slice(searchFrom, end).trim();
    textParts.push(text.slice(lastIdx, start));
    lastIdx = end + TOOL_CALL_CLOSE.length;
    searchFrom = lastIdx;

    const unfenced = rawBlock
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(unfenced) as Record<string, unknown>;
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!name) {
        textParts.push(raw);
        continue;
      }
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
      textParts.push(raw);
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
  private markdown = new MarkdownCodeState();

  feed(delta: string): string {
    if (!delta) return "";
    if (this.capturing) {
      this.captured += delta;
      return "";
    }
    const combined = this.pending + delta;
    let searchFrom = 0;
    while (searchFrom < combined.length) {
      const openIdx = combined.indexOf(TOOL_CALL_OPEN, searchFrom);
      if (openIdx < 0) break;
      this.markdown.advance(combined.slice(searchFrom, openIdx));
      if (!this.markdown.insideCode) {
        const before = combined.slice(0, openIdx);
        this.capturing = true;
        this.captured = combined.slice(openIdx);
        this.pending = "";
        return before;
      }
      this.markdown.advance(TOOL_CALL_OPEN);
      searchFrom = openIdx + TOOL_CALL_OPEN.length;
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
    const emit = holdLen > 0 ? combined.slice(0, combined.length - holdLen) : combined;
    this.markdown.advance(emit.slice(searchFrom));
    return emit;
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

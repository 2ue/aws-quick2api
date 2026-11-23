import type { QuickAgentMode, QuickThinkingEffort } from "../aws-quick/types.js";

export interface ModelDefinition {
  id: string;
  mode: QuickAgentMode;
  name: string;
  thinking?: { suffix: string; defaultEffort: QuickThinkingEffort };
  observed?: string;
  aliases: string[];
}

export const BUILTIN_MODEL_CONFIG: readonly ModelDefinition[] = [
  { id: "claude-haiku-5-5", mode: "fast", name: "Claude Haiku 5.5 via Quick", observed: "us.anthropic.claude-haiku-5-5", aliases: ["quick-fast", "quick-haiku-5.5", "amazon-fast", "fast", "haiku", "claude-haiku-5.5"] },
  { id: "claude-sonnet-5-5", mode: "balanced", thinking: { suffix: "-think", defaultEffort: "high" }, name: "Claude Sonnet 5.5 via Quick", observed: "us.anthropic.claude-sonnet-5-5", aliases: ["quick-balanced", "quick-sonnet-5.5", "amazon-balanced", "balanced", "sonnet", "claude-sonnet-5.5", "auto", "default"] },
  { id: "claude-opus-5-5", mode: "smart", thinking: { suffix: "-think", defaultEffort: "high" }, name: "Claude Opus 5.5 via Quick", observed: "us.anthropic.claude-opus-5-5", aliases: ["quick-smart", "quick-opus-5.5", "amazon-smart", "smart", "opus", "claude-opus-5.5"] },
  { id: "quick-advanced", mode: "advanced", name: "Quick Advanced", aliases: ["advanced"] },
];

export const BUILTIN_MODEL_VERIFIED_AT = "2026-11-23";

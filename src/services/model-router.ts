import { BUILTIN_MODEL_CONFIG, type ModelDefinition } from "./model-config.js";
import type { ModelSelection, QuickAgentMode, QuickThinkingEffort, SDKModel } from "../aws-quick/types.js";
import { GatewayError } from "../core/types.js";

export interface ModelRoute {
  requestedModel: string;
  canonicalModel: string;
  agentMode: QuickAgentMode;
  thinkingEffort: QuickThinkingEffort;
  observedModel?: string;
  normalizations: string[];
}

const definitions = BUILTIN_MODEL_CONFIG;

const aliases = new Map<string, { definition: ModelDefinition; effort: QuickThinkingEffort; normalized?: string }>();
for (const definition of definitions) {
  const bases = [definition.id, ...definition.aliases, ...(definition.observed ? [definition.observed] : [])];
  for (const base of bases) {
    aliases.set(base, { definition, effort: definition.mode === "advanced" ? "high" : "off" });
    if (definition.mode === "advanced") continue;
    for (const effort of ["off", "low", "medium", "high"] as const) aliases.set(`${base}-${effort}`, { definition, effort });
    if (definition.mode !== "fast") {
      aliases.set(`${base}-think`, { definition, effort: "high" });
      aliases.set(`${base}-thinking`, { definition, effort: "high" });
    }
    aliases.set(`${base}-max`, { definition, effort: "high", normalized: "max-to-high" });
    aliases.set(`${base}-xhigh`, { definition, effort: "high", normalized: "xhigh-to-high" });
  }
}
aliases.set("quick-balanced-think", { definition: definitions[1]!, effort: "medium" });
aliases.set("quick-smart-think", { definition: definitions[2]!, effort: "high" });

function modelBase(raw: string): string {
  return raw.split("[")[0]!.trim().toLowerCase().replace(/\([^)]*\)$/, "").trim();
}

export function canonicalModelId(raw: string): string {
  const base = modelBase(raw || "quick-balanced");
  return aliases.get(base)?.definition.id ?? base;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseEffort(raw: unknown, field: string, normalizations: string[]): QuickThinkingEffort {
  if (typeof raw !== "string") throw new GatewayError(`${field} must be a reasoning effort string.`, 400, "invalid_reasoning_effort", field);
  switch (raw.trim().toLowerCase()) {
    case "off": case "none": case "disabled": case "false": return "off";
    case "low": case "minimal": return "low";
    case "medium": case "mid": return "medium";
    case "high": return "high";
    case "max": case "xhigh":
      normalizations.push(`${field}:${raw.trim().toLowerCase()}-to-high`);
      return "high";
    default: throw new GatewayError(`Unsupported ${field}; use off, low, medium or high.`, 400, "invalid_reasoning_effort", field);
  }
}

export function resolveModelRoute(requestedModel: string | undefined, body: Record<string, unknown> = {}, allowAdvanced = false): ModelRoute {
  const raw = requestedModel?.trim() || "quick-balanced";
  if (!/^[^\[\]]+(?:\[[^\[\]]+\])?$/.test(raw)) throw new GatewayError("Invalid model option syntax.", 400, "invalid_model_option", "model");
  const found = aliases.get(modelBase(raw));
  if (!found) throw new GatewayError(`Model '${raw}' was not found.`, 404, "model_not_found", "model");
  if (found.definition.mode === "advanced" && !allowAdvanced) {
    throw new GatewayError("Quick Advanced is not enabled by this gateway.", 403, "model_not_available", "model");
  }
  const normalizations: string[] = found.normalized ? [found.normalized] : [];
  let effort = found.effort;
  const bracket = /\[([^\]]*)\]$/.exec(raw)?.[1];
  if (bracket) {
    for (const option of bracket.split(",")) {
      const [key, value] = option.split("=").map((s) => s.trim());
      if (key !== "effort" && key !== "thinking_effort") throw new GatewayError(`Unknown model option '${key}'.`, 400, "invalid_model_option", "model");
      effort = parseEffort(value, "model.effort", normalizations);
    }
  }
  const reasoning = record(body.reasoning);
  const outputConfig = record(body.output_config);
  const thinking = record(body.thinking);
  const fields: Array<[string, unknown]> = [
    ["reasoning_effort", body.reasoning_effort], ["thinking_effort", body.thinking_effort],
    ["effort", body.effort], ["reasoning.effort", reasoning?.effort], ["output_config.effort", outputConfig?.effort],
  ];
  const explicit = fields.filter(([, value]) => value !== undefined).map(([key, value]) => parseEffort(value, key, normalizations));
  if (thinking?.budget_tokens !== undefined && thinking.type !== "disabled") {
    const budget = thinking.budget_tokens;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) throw new GatewayError("thinking.budget_tokens must be positive.", 400, "invalid_reasoning_effort", "thinking.budget_tokens");
    const approximate = budget < 2048 ? "low" : budget < 8192 ? "medium" : "high";
    if (!explicit.length) explicit.push(approximate);
    normalizations.push("thinking.budget_tokens:approximate");
  }
  if (new Set(explicit).size > 1) throw new GatewayError("Conflicting reasoning effort parameters.", 400, "conflicting_reasoning_effort");
  if (explicit.length) effort = explicit[0]!;
  const disabled = thinking?.type === "disabled" || body.enable_thinking === false;
  const enabled = thinking?.type === "enabled" || thinking?.type === "adaptive" || body.enable_thinking === true;
  if (disabled && enabled || disabled && explicit.length && effort !== "off" || enabled && explicit.length && effort === "off") {
    throw new GatewayError("Thinking enablement conflicts with reasoning effort.", 400, "conflicting_reasoning_effort");
  }
  if (disabled) effort = "off";
  else if (enabled && !explicit.length) effort = "high";
  if (found.definition.mode === "fast" && effort !== "off") {
    normalizations.push("fast:thinking-off");
    effort = "off";
  }
  if (found.definition.mode === "advanced" && effort === "off") {
    normalizations.push("advanced:thinking-high");
    effort = "high";
  }
  return { requestedModel: raw, canonicalModel: found.definition.id, agentMode: found.definition.mode, thinkingEffort: effort,
    ...(found.definition.observed ? { observedModel: found.definition.observed } : {}), normalizations };
}

export function routeSelection(route: ModelRoute): ModelSelection {
  return { model: route.canonicalModel, agentMode: route.agentMode, thinkingEffort: route.thinkingEffort };
}

export function canonicalModelCatalog(_allowAdvanced = false): SDKModel[] {
  return definitions.filter((d) => d.mode !== "advanced").flatMap((d) => {
    const base: SDKModel = { id: d.id, name: d.name, displayName: d.name, agentMode: d.mode, thinkingEffort: "off",
      parameters: d.mode === "fast" ? [] : [{ id: "effort", values: ["off", "low", "medium", "high"] }] };
    return d.mode === "fast" ? [base] : [base, { ...base, id: `${d.id}-think`, name: `${d.name} (Thinking)`,
      displayName: `${d.name} (Thinking)`, thinkingEffort: "high" }];
  });
}

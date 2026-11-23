import type { ModelSelection, QuickThinkingEffort, SDKModel } from "../aws-quick/types.js";

export const DEFAULT_MODEL = "quick-balanced";

export const AWS_QUICK_MODELS: SDKModel[] = [
  {
    id: "quick-fast",
    name: "AWS Quick Fast (Haiku / GPT Luna)",
    displayName: "Quick Fast (Haiku)",
    description: "Fastest option for everyday tasks (typically routes to Haiku / GPT Luna)",
    agentMode: "fast",
    thinkingEffort: "off",
    parameters: [],
  },
  {
    id: "quick-balanced",
    name: "AWS Quick Balanced (Sonnet / GPT Terra)",
    displayName: "Quick Balanced (Sonnet)",
    description: "Balanced speed and depth (typically routes to Sonnet / GPT Terra; supports reasoning)",
    agentMode: "balanced",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high"] }],
  },
  {
    id: "quick-balanced-think",
    name: "AWS Quick Balanced Think (Sonnet)",
    displayName: "Quick Balanced Think (Sonnet)",
    description: "Balanced mode with reasoning enabled by default (typically routes to Sonnet)",
    agentMode: "balanced",
    thinkingEffort: "medium",
    parameters: [{ id: "effort", values: ["low", "medium", "high"] }],
  },
  {
    id: "quick-smart",
    name: "AWS Quick Smart (Opus / GPT Sol)",
    displayName: "Quick Smart (Opus)",
    description: "Deeper reasoning and highest quality (typically routes to Opus / GPT Sol; supports reasoning)",
    agentMode: "smart",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high"] }],
  },
  {
    id: "quick-smart-think",
    name: "AWS Quick Smart Think (Opus)",
    displayName: "Quick Smart Think (Opus)",
    description: "Smart mode with high reasoning enabled by default (typically routes to Opus)",
    agentMode: "smart",
    thinkingEffort: "high",
    parameters: [{ id: "effort", values: ["low", "medium", "high"] }],
  },
  {
    id: "quick-advanced",
    name: "AWS Quick Advanced (Opus Max)",
    displayName: "Quick Advanced",
    description: "Advanced mode with always-on deep reasoning (requires Advanced entitlement)",
    agentMode: "advanced",
    thinkingEffort: "high",
    parameters: [{ id: "effort", values: ["low", "medium", "high"] }],
  },
];

export async function listLiveModels(
  _apiKey: string,
  fetcher?: (key: string) => Promise<SDKModel[]>,
): Promise<SDKModel[]> {
  if (fetcher) return fetcher(_apiKey);
  return AWS_QUICK_MODELS;
}

function parseEffort(raw: unknown): QuickThinkingEffort | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "off" || k === "none" || k === "disabled" || k === "false") return "off";
  if (k === "low" || k === "minimal") return "low";
  if (k === "medium" || k === "mid") return "medium";
  if (k === "high" || k === "xhigh" || k === "max") return "high";
  return undefined;
}

export function resolveModelSelection(
  requestedModel: string | undefined,
  body: Record<string, unknown> = {},
  _modelSchema?: SDKModel,
): { selection: ModelSelection; canonicalId: string } {
  const raw = (requestedModel || "").trim() || DEFAULT_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(raw);
  const baseId = (match?.[1] || DEFAULT_MODEL).trim().toLowerCase().replace(/\([^)]*\)$/, "").trim();

  const found = AWS_QUICK_MODELS.find((m) => m.id === baseId) ?? AWS_QUICK_MODELS[1]!;

  let effort: QuickThinkingEffort = found.thinkingEffort;

  // Check bracket param e.g. quick-balanced[effort=high]
  if (match?.[2]) {
    for (const part of match[2].split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k === "effort" || k === "thinking_effort") {
        const parsed = parseEffort(v);
        if (parsed) effort = parsed;
      }
    }
  }

  // Check OpenAI reasoning_effort / Responses reasoning.effort / Anthropic & GLM thinking / Qwen enable_thinking
  const reasoningObj = body.reasoning && typeof body.reasoning === "object"
    ? (body.reasoning as { effort?: unknown })
    : undefined;
  const thinkingObj = body.thinking && typeof body.thinking === "object"
    ? (body.thinking as { type?: string; budget_tokens?: number })
    : undefined;
  const thinkingEffortFromObj: QuickThinkingEffort | undefined =
    thinkingObj?.type === "enabled"
      ? typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 2048
        ? "low"
        : typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 8192
          ? "medium"
          : "high"
      : thinkingObj?.type === "disabled"
        ? "off"
        : undefined;
  const enableThinkingEffort: QuickThinkingEffort | undefined =
    body.enable_thinking === true
      ? found.agentMode === "balanced"
        ? "medium"
        : "high"
      : body.enable_thinking === false
        ? "off"
        : undefined;

  const bodyEffort =
    parseEffort(body.reasoning_effort) ||
    parseEffort(body.effort) ||
    parseEffort(reasoningObj?.effort) ||
    thinkingEffortFromObj ||
    enableThinkingEffort;

  if (bodyEffort && found.agentMode !== "fast") {
    effort = found.agentMode === "advanced" && bodyEffort === "off" ? "high" : bodyEffort;
  }

  return {
    selection: {
      model: found.id,
      agentMode: found.agentMode,
      thinkingEffort: found.agentMode === "fast" ? "off" : effort,
    },
    canonicalId: found.id,
  };
}

export function formatOpenAiModelList(models: SDKModel[]): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name?: string;
}> {
  return models.map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "aws-quick",
    ...(m.displayName ? { name: m.displayName } : {}),
  }));
}

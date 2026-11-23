import { canonicalModelCatalog, resolveModelRoute, routeSelection } from "./model-router.js";
import type { ModelSelection, QuickThinkingEffort, SDKModel } from "../aws-quick/types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const AWS_QUICK_MODELS: SDKModel[] = canonicalModelCatalog();

export async function listLiveModels(
  _apiKey: string,
  fetcher?: (key: string) => Promise<SDKModel[]>,
): Promise<SDKModel[]> {
  if (fetcher) return fetcher(_apiKey);
  return AWS_QUICK_MODELS;
}

export function resolveModelSelection(
  requestedModel: string | undefined,
  body: Record<string, unknown> = {},
  _modelSchema?: SDKModel,
): { selection: ModelSelection; canonicalId: string } {
  const route = resolveModelRoute(requestedModel, body, process.env.ENABLE_ADVANCED_MODEL === "true");
  return { selection: routeSelection(route), canonicalId: route.canonicalModel };
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

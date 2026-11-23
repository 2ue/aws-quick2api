import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { GatewayError, type NormalizedTool, type NormalizedToolCall, type ToolChoiceMode } from "./types.js";

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, addUsedSchema: false });

function hasReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasReference);
  return Object.entries(value).some(([key, v]) => key === "$ref" && typeof v === "string" && !v.startsWith("#") || hasReference(v));
}

export function toolContract(tools: readonly NormalizedTool[], choice: ToolChoiceMode, parallel: boolean) {
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (validators.has(tool.name)) throw new GatewayError("Duplicate tool name.", 400, "invalid_tool_schema");
    try {
      if (hasReference(tool.inputSchema)) throw new Error("external schema reference");
      validators.set(tool.name, ajv.compile(tool.inputSchema));
    } catch {
      throw new GatewayError(`Invalid JSON schema for tool '${tool.name}'.`, 400, "invalid_tool_schema");
    }
  }
  return (calls: readonly NormalizedToolCall[]): void => {
    const forced = typeof choice === "object" ? choice.name : undefined;
    if (choice === "none" && calls.length || !parallel && calls.length > 1 || (choice === "required" || forced) && !calls.length) {
      throw new GatewayError("Upstream response did not satisfy the requested tool choice.", 502, "invalid_tool_call");
    }
    for (const call of calls) {
      const validate = validators.get(call.name);
      if (!validate || forced && call.name !== forced || !validate(call.argsObject)) {
        throw new GatewayError(`Upstream returned an invalid call for tool '${call.name}'.`, 502, "invalid_tool_call");
      }
    }
  };
}

import type { TSchema } from "typebox";
import type { Type } from "typebox";

export type ToolConfig = {
  parameters?: ReturnType<typeof Type.Object>;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
};



export type CoreTool = {
  description?: string;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

/** Neutral native operation result; writes retain domain-owned certainty semantics. */
export type CodecksOperationPayload = { text: string; payload: Record<string, unknown> };
export type CodecksStructuredOutput = (
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }
) & Record<string, unknown>;

/** Compatibility name for accepted read adapters. */
export type CodecksStructuredReadOutput = CodecksStructuredOutput;

/** Internal domain contribution; lifecycle and request context stay in the Pi adapter. */
export type CodecksToolDefinition = {
  exportName: string;
  tool: CoreTool;
  config: ToolConfig;
  read?: (args: Record<string, unknown>) => Promise<CodecksOperationPayload>;
  executePayload?: (args: Record<string, unknown>) => Promise<CodecksOperationPayload>;
  outputSchema?: TSchema;
  projectOutput?: (payload: unknown) => CodecksStructuredOutput;
  cardTextPresentation?: boolean;
};

export function composeCodecksToolCatalog(...groups: readonly (readonly CodecksToolDefinition[])[]): ReadonlyMap<string, CodecksToolDefinition> {
  const catalog = new Map<string, CodecksToolDefinition>();
  for (const group of groups) for (const definition of group) {
    if (catalog.has(definition.exportName)) throw new Error(`Duplicate Codecks tool definition '${definition.exportName}'.`);
    catalog.set(definition.exportName, definition);
  }
  return catalog;
}

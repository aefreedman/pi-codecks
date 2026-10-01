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

export type CodecksStructuredReadOutput = (
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }
) & Record<string, unknown>;

/** Internal domain contribution; lifecycle and request context stay in the Pi adapter. */
export type CodecksToolDefinition = {
  exportName: string;
  tool: CoreTool;
  config: ToolConfig;
  read?: (args: Record<string, unknown>) => Promise<{ text: string; payload: Record<string, unknown> }>;
  outputSchema?: TSchema;
  projectOutput?: (payload: unknown) => CodecksStructuredReadOutput;
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

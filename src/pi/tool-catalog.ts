import { REPORT_TOOL_DEFINITIONS } from "../tools/reports/definitions";
import { CARD_TOOL_DEFINITIONS } from "../tools/cards/definitions";
import { CONVERSATION_TOOL_DEFINITIONS } from "../tools/conversations/definitions";
import { ENTITY_TOOL_DEFINITIONS } from "../tools/entities/definitions";
import * as core from "../codecks-core";
import { CARD_GET_OUTPUT_SCHEMA, projectCardGetOutput } from "../card-get-output";
import { CARD_SEARCH_OUTPUT_SCHEMA, projectCardSearchOutput } from "../card-search-output";
import { CODECKS_EXPORTS, TOOL_CONFIG } from "./tool-metadata";
import { composeCodecksToolCatalog, type CodecksToolDefinition, type CoreTool } from "./tool-definition";

// Transitional group: integrator replaces these entries with domain-owned groups
// as each extraction lands. Domain definitions need no changes to index or adapter.
const extractedNames = new Set([...ENTITY_TOOL_DEFINITIONS, ...CONVERSATION_TOOL_DEFINITIONS, ...CARD_TOOL_DEFINITIONS, ...REPORT_TOOL_DEFINITIONS].map(definition => definition.exportName));
const retainedDefinitions: CodecksToolDefinition[] = CODECKS_EXPORTS.filter(name => !extractedNames.has(name)).map(exportName => {
  const candidate = (core as Record<string, unknown>)[exportName] as CoreTool | undefined;
  if (!candidate || typeof candidate.execute !== "function") {
    throw new Error(`Missing Codecks core tool export '${exportName}'.`);
  }
  return {
    exportName,
    tool: candidate,
    config: TOOL_CONFIG[exportName] ?? {},
    ...(exportName === "card_get" ? { read: (args: Record<string, unknown>) => core.card_get.read(args), outputSchema: CARD_GET_OUTPUT_SCHEMA, projectOutput: projectCardGetOutput, cardTextPresentation: true } :
      exportName === "card_search" ? { read: (args: Record<string, unknown>) => core.card_search.read(args), outputSchema: CARD_SEARCH_OUTPUT_SCHEMA, projectOutput: projectCardSearchOutput } : {}),
  };
});
const catalog = composeCodecksToolCatalog(retainedDefinitions, ENTITY_TOOL_DEFINITIONS, CONVERSATION_TOOL_DEFINITIONS, CARD_TOOL_DEFINITIONS, REPORT_TOOL_DEFINITIONS);

export function getCodecksToolDefinition(exportName: string): CodecksToolDefinition {
  const definition = catalog.get(exportName);
  if (!definition) throw new Error(`Missing Codecks core tool export '${exportName}'.`);
  return definition;
}

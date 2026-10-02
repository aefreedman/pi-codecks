import { REPORT_TOOL_DEFINITIONS } from "../tools/reports/definitions";
import { CARD_TOOL_DEFINITIONS } from "../tools/cards/definitions";
import { CONVERSATION_TOOL_DEFINITIONS } from "../tools/conversations/definitions";
import { ENTITY_TOOL_DEFINITIONS } from "../tools/entities/definitions";
import { RAW_TOOL_DEFINITIONS } from "../tools/raw-definitions";
import { CODECKS_EXPORTS } from "./tool-metadata";
import { composeCodecksToolCatalog, type CodecksToolDefinition } from "./tool-definition";

const catalog = composeCodecksToolCatalog(
  RAW_TOOL_DEFINITIONS, ENTITY_TOOL_DEFINITIONS, CONVERSATION_TOOL_DEFINITIONS,
  CARD_TOOL_DEFINITIONS, REPORT_TOOL_DEFINITIONS,
);
// Registration order and optional activation belong to composition, not domains.
if (catalog.size !== CODECKS_EXPORTS.length || CODECKS_EXPORTS.some(name => !catalog.has(name))) {
  throw new Error("Codecks tool catalog does not match the established export inventory.");
}

export function getCodecksToolDefinition(exportName: string): CodecksToolDefinition {
  const definition = catalog.get(exportName);
  if (!definition) throw new Error(`Missing Codecks core tool export '${exportName}'.`);
  return definition;
}

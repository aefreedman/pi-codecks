import { Type } from "typebox";
import type { CodecksToolDefinition } from "../pi/tool-definition";
import { outputFormatEnum } from "../pi/input-primitives";
import { query, dispatch } from "./raw";

export const RAW_TOOL_DEFINITIONS: readonly CodecksToolDefinition[] = [
  { exportName: "query", tool: query, config: {
    parameters: Type.Object({
      query: Type.Any({ description: "Query object or JSON string." }),
    }),
  } },
  { exportName: "dispatch", tool: dispatch, config: {
    parameters: Type.Object({
      path: Type.String({ description: "Dispatch path without /dispatch/, e.g. cards/create." }),
      payload: Type.Any({ description: "Payload object or JSON string." }),
      format: Type.Optional(outputFormatEnum),
    }),
  } },
];

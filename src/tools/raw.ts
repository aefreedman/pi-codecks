import { CodecksOperationError } from "../runtime/operation-error";
import { getDispatchPolicyMessage, normalizeDispatchPath, normalizeDispatchPayload, runDispatch, runQuery } from "../runtime/transport";
import { normalizeQuery, unwrapData } from "../shared/query";
import { classifyApiErrorCategory, formatJsonMarkdown, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../shared/results";
import { outputFormatArg } from "../pi-tool-compat";
import { tool } from "../pi-tool-compat";

export const query = tool({
    description: "Run a Codecks read query and return JSON.",
    args: {
        query: tool.schema.any().describe("Query object or JSON string."),
    },
    async execute(args)
    {
        let normalized: Record<string, unknown>;
        try
        {
            normalized = normalizeQuery(args.query);
        }
        catch (error)
        {
            return toStructuredErrorResult("json", "query", "validation_error", toErrorMessage(error));
        }

        try
        {
            const payload = await runQuery(normalized);
            return `## Codecks Query Result\n\n${formatJsonMarkdown(unwrapData(payload))}`;
        }
        catch (error)
        {
            return toStructuredErrorResult("json", "query", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }
    },
});

export const dispatch = tool({
    description: "Call a Codecks dispatch endpoint for writes (in-scope operations only).",
    args: {
        path: tool.schema.string().min(1).describe("Dispatch path without /dispatch/, e.g. cards/create."),
        payload: tool.schema.any().describe("Payload object or JSON string."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const path = normalizeDispatchPath(args.path);
        if (!path)
        {
            return toStructuredErrorResult(format, "dispatch", "validation_error", "Dispatch path is required.");
        }

        const policyMessage = getDispatchPolicyMessage(path);
        if (policyMessage)
        {
            return toStructuredErrorResult(format, "dispatch", "out_of_scope", policyMessage, { path });
        }

        let payload: Record<string, unknown>;
        try
        {
            payload = normalizeDispatchPayload(path, normalizeQuery(args.payload));
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "dispatch", "validation_error", toErrorMessage(error), { path });
        }

        try
        {
            const response = await runDispatch(path, payload);
            if (format === "json")
            {
                return toStructuredResult(format, "dispatch", "## Dispatch Result", {
                    path,
                    result: unwrapData(response),
                });
            }
            return `## Codecks Dispatch Result\n\n${formatJsonMarkdown(unwrapData(response))}`;
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "dispatch", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), { path, ...getOperationErrorData(error) });
        }
    },
});

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
    runExternalProviderIdentityCheck,
    type CodecksExternalProviderCheckResult,
} from "../src/codecks-core.ts";

type LiveValidationOutput = Readonly<{
    status: "authenticated" | "not_authenticated";
    category: CodecksExternalProviderCheckResult["category"];
    durationMs: number;
}>;

type LiveValidationOptions = Readonly<{
    /** Injectable only for deterministic no-network tests; CLI configuration is process.env only. */
    fetchImplementation?: typeof fetch;
    write?: (line: string) => void;
    now?: () => number;
}>;

/** Keeps public timing diagnostics useful without exposing unbounded runtime detail. */
export const MAX_EXTERNAL_PROVIDER_LIVE_VALIDATION_DURATION_MS = 60_000;

const hasExplicitLiveAuthorization = (): boolean =>
    process.env.CODECKS_CREDENTIAL_PROVIDER === "external-helper"
    && process.env.PI_CODECKS_ALLOW_LIVE_VALIDATION === "1";

/**
 * Runs one fixed exact-read identity query only after the process explicitly
 * selects the external helper and acknowledges separately authorized live work.
 * It deliberately exposes no request, account, helper, token, path, error,
 * stack, or response-body diagnostic surface.
 */
export const runExternalProviderLiveValidation = async (
    options: LiveValidationOptions = {},
): Promise<LiveValidationOutput> =>
{
    const now = options.now ?? Date.now;
    const startedAt = now();
    let result: CodecksExternalProviderCheckResult = { category: "invalid_configuration" };
    if (hasExplicitLiveAuthorization())
    {
        try
        {
            result = await runExternalProviderIdentityCheck(options.fetchImplementation);
        }
        catch
        {
            // The launcher has one fixed public failure category and never prints caught diagnostics.
            result = { category: "unavailable" };
        }
    }

    const output: LiveValidationOutput = {
        status: result.category === "authenticated" ? "authenticated" : "not_authenticated",
        category: result.category,
        durationMs: Math.min(
            MAX_EXTERNAL_PROVIDER_LIVE_VALIDATION_DURATION_MS,
            Math.max(0, now() - startedAt),
        ),
    };
    (options.write ?? ((line) => process.stdout.write(line)))(`${JSON.stringify(output)}\n`);
    return output;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
{
    void runExternalProviderLiveValidation().then((result) =>
    {
        if (result.status !== "authenticated") process.exitCode = 1;
    });
}

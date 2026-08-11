import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExternalHelperCredential } from "./codecks-external-helper";

const FAILURE = "Codecks 1Password credential provider configuration is invalid.";
const CHILD_PATH = fileURLToPath(new URL("./integrations/codecks-onepassword-credential-helper.mjs", import.meta.url));
const startupPath = process.env.PATH ?? "";
let resolvedExecutable: string | undefined;

type Request = Readonly<{ account: string; profileKey?: string; signal: AbortSignal }>;

const fail = (): never => { throw new Error(FAILURE); };

const canonicalExecutable = (candidate: string): string | undefined =>
{
    try
    {
        if (!isAbsolute(candidate) || !statSync(candidate).isFile()) return undefined;
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
    }
    catch { return undefined; }
};

const candidatesForEntry = (entry: string): string[] =>
{
    if (!entry) return [];
    if (process.platform !== "win32") return [join(entry, "op")];
    const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";").filter(Boolean);
    return extensions.map((extension) => join(entry, `op${extension.toLowerCase()}`));
};

/** Resolves only explicit startup PATH entries; empty entries never mean cwd. */
export const resolveOnePasswordExecutable = (): string =>
{
    if (resolvedExecutable) return resolvedExecutable;
    const override = process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE?.trim();
    if (override)
    {
        resolvedExecutable = canonicalExecutable(override) ?? fail();
        return resolvedExecutable;
    }

    const matches = new Set<string>();
    for (const entry of startupPath.split(process.platform === "win32" ? ";" : ":"))
    {
        for (const candidate of candidatesForEntry(entry.trim()))
        {
            const resolved = canonicalExecutable(candidate);
            if (resolved) matches.add(resolved);
        }
    }
    if (matches.size !== 1) fail();
    resolvedExecutable = [...matches][0];
    return resolvedExecutable;
};

const reference = (): string =>
{
    const value = process.env.PI_CODECKS_ONEPASSWORD_REFERENCE?.trim();
    if (!value) fail();
    return value;
};

export const resolveOnePasswordCredential = async (request: Request): Promise<{ token: string; providerId: "onepassword" }> =>
{
    // No executable lookup or child launch occurs until the explicitly selected provider resolves.
    const executable = resolveOnePasswordExecutable();
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE: executable,
        PI_CODECKS_ONEPASSWORD_REFERENCE: reference(),
    };
    const credential = await resolveExternalHelperCredential(request, {
        modulePath: CHILD_PATH,
        environment,
        providerId: "onepassword",
    });
    return { token: credential.token, providerId: "onepassword" };
};

export const __onepasswordTest = {
    canonicalExecutable,
    resolveOnePasswordExecutable,
    resetExecutable: (): void => { resolvedExecutable = undefined; },
    childPath: CHILD_PATH,
    failure: FAILURE,
};

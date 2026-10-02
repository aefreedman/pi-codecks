
export type CodecksConfig = {
    account: string;
    token: string;
    baseUrl: string;
    credentialProviderId?: string;
    credentialGeneration?: unknown;
    kind: "ORG" | "PERSONAL";
    profileKey: string;
};

export type CodecksFetch = typeof fetch;

export type CodecksExternalProviderCheckCategory =
    | "authenticated"
    | "authentication_rejected"
    | "invalid_configuration"
    | "malformed_response"
    | "unavailable";

export type CodecksExternalProviderCheckResult = Readonly<{
    category: CodecksExternalProviderCheckCategory;
}>;

export type CodecksCredentialRequest = Readonly<{
    account: string;
    profileKey?: string;
    baseUrl?: string;
    signal: AbortSignal;
}>;

export type CodecksCredential = Readonly<{
    token: string;
    providerId: string;
    credentialGeneration?: unknown;
}>;

export interface CodecksCredentialProvider {
    readonly id: string;
    resolve(request: CodecksCredentialRequest): Promise<CodecksCredential>;
}

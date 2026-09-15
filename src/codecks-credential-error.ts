export type CredentialFailureCategory =
    | "credential_rate_limited"
    | "credential_configuration_invalid"
    | "credential_helper_unavailable"
    | "credential_helper_timeout"
    | "credential_helper_protocol_error"
    | "credential_cancelled"
    | "credential_capacity";

const messages: Record<CredentialFailureCategory, string> = {
    credential_rate_limited: "1Password rate-limited credential retrieval. Wait before retrying.",
    credential_configuration_invalid: "Codecks 1Password credential provider configuration is invalid.",
    credential_helper_unavailable: "1Password credential retrieval failed for an unknown reason. Diagnose the provider before retrying.",
    credential_helper_timeout: "1Password credential retrieval timed out. Diagnose the provider before retrying.",
    credential_helper_protocol_error: "1Password credential helper returned an invalid response. Check the provider installation before retrying.",
    credential_cancelled: "1Password credential retrieval cancelled.",
    credential_capacity: "1Password credential retrieval is at its process-local capacity. Wait before retrying.",
};

/** Only fixed allowlisted text crosses from credential retrieval into tool diagnostics. */
export class CodecksCredentialError extends Error
{
    readonly provider = "onepassword";
    readonly stage = "credential_retrieval";
    readonly retryable: boolean;
    constructor(readonly credentialCategory: CredentialFailureCategory)
    {
        super(messages[credentialCategory]);
        this.name = "CodecksCredentialError";
        this.retryable = credentialCategory === "credential_rate_limited";
    }
}

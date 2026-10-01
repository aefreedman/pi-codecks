
export class CodecksOperationError extends Error
{
    constructor(
        readonly category: "caller_aborted" | "rate_limit_queue_aborted" | "request_timeout" | "rate_limited" | "scan_queue_full" | "response_too_large" | "invalid_response_stream" | "api_error" | "unsupported_token" | "credential_profile_mismatch" | "personal_token_required" | "org_actor_unverified" | "authentication_rejected" | "account_mismatch" | "missing_scope" | "forbidden",
        message: string,
        readonly details: Record<string, unknown> = {},
    )
    {
        super(message);
        this.name = "CodecksOperationError";
    }
}

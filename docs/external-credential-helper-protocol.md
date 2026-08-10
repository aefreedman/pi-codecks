# External Codecks credential-helper protocol

`pi-codecks` can use a trusted local helper instead of its ambient environment provider. This is an adapter-author contract, not a Pi tool API: neither the provider selector nor a helper path is model-facing input. It is manager-neutral: adapters for 1Password, Bitwarden, an OS keychain, or an enterprise vault implement this contract without adding manager-specific behavior to `pi-codecks`.

For the user-facing choice, migration, and security limits, see [Configuration in the README](../README.md#configuration) and [Security](../SECURITY.md#credential-and-data-handling).

## Migration and launcher configuration

Existing users may leave `CODECKS_CREDENTIAL_PROVIDER` unset and continue with the default ambient `environment` provider. To migrate to an adapter, retain non-secret account/profile/API-base settings, move manager authentication and references into trusted adapter configuration, and set the explicit selector plus helper module path below. No Codecks tool arguments, model input, or helper auto-discovery participate in selection.

Set these values before starting Pi:

```bash
export CODECKS_CREDENTIAL_PROVIDER=external-helper
export CODECKS_CREDENTIAL_HELPER_MODULE=/absolute/path/to/codecks-helper.mjs
```

The module path must be an existing absolute `.js` or `.mjs` file. `pi-codecks` invokes it as `process.execPath <module-path>` with `shell: false` and no caller-, account-, model-, or manager-selected arguments. There is no helper discovery. A configured helper is authoritative: configuration, launch, protocol, timeout, or cancellation failure does **not** fall back to `CODECKS_TOKEN`, profile tokens, or another provider.

Adapters should publish a stable package-relative helper location and setup guidance; the trusted launcher resolves that location to the required absolute path. An adapter supplies credentials only; it does not implement Codecks HTTP operations.

The optional repository-only `validate:external-provider-live` launcher is separately authorized live work, not an adapter requirement. It will use this provider only when the process also sets the exact non-secret acknowledgement `PI_CODECKS_ALLOW_LIVE_VALIDATION=1`; otherwise it fails before helper execution or fetch. It never accepts the `environment` provider or ambient-token fallback.

## Version 1 exchange

The parent writes exactly one JSON value to helper stdin, with no credential material:

```json
{"version":1,"service":"codecks","account":"example-account","profile":"optional-profile"}
```

`profile` is omitted when no Codecks profile is active. The helper must write exactly one JSON value to stdout and exit zero:

```json
{"version":1,"credential":"credential-value"}
```

The credential must be a nonempty string. Do not write banners, line-oriented diagnostics, JSONL, additional properties, or any other stdout bytes. Protocol version 1 has no expiry, refresh, lease, account override, or metadata fields.

## Helper requirements

- Read only the single stdin request and return only the single stdout response.
- Treat request account/profile as request metadata, not as command-line inputs or diagnostic output.
- Keep credential-manager authentication and references in the helper's trusted configuration. `pi-codecks` does not recognize manager reference syntax.
- Never emit credentials, references, account data, paths, or request metadata to stdout or stderr. Parent stderr is bounded and discarded, so it is not a result channel.
- Exit nonzero for an unavailable manager or unresolved credential. Do not attempt a fallback token source that the adapter was not configured to use.
- Handle parent termination promptly. `pi-codecks` applies bounded runtime/stdout/stderr limits and makes a best-effort process-tree termination attempt on timeout or operation cancellation; its caller settles without waiting for that attempt to complete.

The helper inherits a sanitized environment. `pi-codecks` case-insensitively removes global and profile Codecks direct-token and secret-reference variables plus profile/provider/helper selectors before launching it; manager-specific variables may remain. This narrows accidental ambient-Codecks fallback, but it is not an operating-system isolation boundary against trusted same-user code.

## Security boundaries and non-goals

The trusted launcher chooses the helper path and manager configuration. The protocol keeps tokens out of Pi tool arguments, helper argv, public results, and normal diagnostics, but it does not protect against malicious installed extensions, trusted same-user processes, or memory inspection. JavaScript credentials cannot be reliably zeroed; helpers and callers should keep them short-lived.

Version 1 deliberately has no secret broker or daemon, adapter discovery, package-manager lookup, credential cache across top-level operations, refresh/lease metadata, automatic re-resolution, automatic 401 retry, account override, or model-facing credential API. `pi-codecks` remains independent of every credential-manager package.

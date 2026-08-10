# External Codecks credential-helper protocol

`pi-codecks` can use a trusted local helper instead of its ambient environment provider. This is an adapter-author contract, not a Pi tool API: neither the provider selector nor a helper path is model-facing input.

## Launcher configuration

Set these values before starting Pi:

```bash
export CODECKS_CREDENTIAL_PROVIDER=external-helper
export CODECKS_CREDENTIAL_HELPER_MODULE=/absolute/path/to/codecks-helper.mjs
```

The module path must be an existing absolute `.js` or `.mjs` file. `pi-codecks` invokes it as `process.execPath <module-path>` with `shell: false` and no caller-, account-, model-, or manager-selected arguments. There is no helper discovery. A configured helper is authoritative: configuration, launch, protocol, timeout, or cancellation failure does **not** fall back to `CODECKS_TOKEN`, profile tokens, or another provider.

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

The helper inherits a sanitized environment. `pi-codecks` case-insensitively removes global and profile Codecks `TOKEN`, `API_TOKEN`, `TOKEN_REF`, and `TOKEN_OP_REF` variables plus `CODECKS_PROFILE` and the provider/helper selector variables before launching it; manager-specific variables may remain. This narrows accidental ambient-Codecks fallback, but it is not an operating-system isolation boundary against trusted same-user code.

const CREDENTIAL_ENVIRONMENT = /^(?:CODECKS|PI_CODECKS)_/i;

/**
 * Isolate deterministic fixtures from launcher-provided Codecks configuration.
 * Each test process gets synthetic environment-provider credentials and restores
 * its original selector/configuration when it exits.
 */
export function useInertEnvironmentCredentialProvider(): void {
  const saved = new Map(
    Object.entries(process.env).filter(([key]) => CREDENTIAL_ENVIRONMENT.test(key)),
  );
  for (const key of Object.keys(process.env)) {
    if (CREDENTIAL_ENVIRONMENT.test(key)) delete process.env[key];
  }
  process.env.CODECKS_CREDENTIAL_PROVIDER = "environment";
  process.env.CODECKS_ACCOUNT = "test-account";
  process.env.CODECKS_TOKEN = "test-token";

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(process.env)) {
      if (CREDENTIAL_ENVIRONMENT.test(key)) delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
  };
  process.once("exit", restore);
}

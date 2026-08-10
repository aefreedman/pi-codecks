import { appendFileSync, writeFileSync } from "node:fs";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  const requestText = Buffer.concat(chunks).toString("utf8");
  if (process.env.PI_CODECKS_HELPER_COUNTER_PATH) appendFileSync(process.env.PI_CODECKS_HELPER_COUNTER_PATH, "1\n");
  if (process.env.PI_CODECKS_HELPER_CAPTURE_PATH) {
    writeFileSync(process.env.PI_CODECKS_HELPER_CAPTURE_PATH, JSON.stringify({
      requestText,
      extraArgCount: process.argv.length - 2,
      codecksCredentialKeys: Object.keys(process.env).filter((key) => {
        const normalized = key.toUpperCase();
        return /^CODECKS_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
          || /^CODECKS_PROFILE_[A-Z0-9_]+_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
          || ["CODECKS_PROFILE", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE"].includes(normalized);
      }),
      managerSetting: process.env.PI_CODECKS_HELPER_MANAGER_SETTING,
    }));
  }

  switch (process.env.PI_CODECKS_HELPER_MODE) {
    case "malformed": process.stdout.write("not-json"); break;
    case "extra": process.stdout.write('{"version":1,"credential":"inert-helper-token"}{"extra":true}'); break;
    case "wrong-version": process.stdout.write('{"version":2,"credential":"inert-helper-token"}'); break;
    case "empty": process.stdout.write('{"version":1,"credential":"   "}'); break;
    case "oversized": process.stdout.write("x".repeat(20 * 1024)); break;
    case "stderr": process.stderr.write("attempted disclosure: inert-helper-token"); process.stdout.write('{"version":1,"credential":"inert-helper-token"}'); break;
    case "stderr-oversized": process.stderr.write("x".repeat(20 * 1024)); break;
    case "nonzero": process.stderr.write("attempted disclosure: inert-helper-token"); process.exitCode = 7; break;
    case "timeout": setTimeout(() => undefined, 60_000); break;
    case "close": break;
    default: process.stdout.write('{"version":1,"credential":"inert-helper-token"}'); break;
  }
});

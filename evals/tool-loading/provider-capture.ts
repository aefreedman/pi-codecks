import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Eval-only capture; raw payloads stay out of JSON-mode stdout and are deleted by default. */
const CAPTURE_ENV = "PI_CODECKS_EVAL_PROVIDER_CAPTURE";

export default function codecksProviderCapture(pi: ExtensionAPI): void {
  const capturePath = process.env[CAPTURE_ENV];
  if (!capturePath) return;
  pi.on("before_provider_request", (event) => {
    try {
      appendFileSync(capturePath, `${JSON.stringify({ timestamp: Date.now(), payload: event.payload })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Capture is observational and must never change the model trial result.
    }
  });
}

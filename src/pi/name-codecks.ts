import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeCardCode, cardCodeToAccountSeq } from "../shared/card-reference";
import { runWithAbortSignal } from "../runtime/operation-context";
import { readCardGet } from "../tools/cards/reads";
import { projectCardGetOutput } from "../card-get-output";

export function registerNameCodecks(pi: ExtensionAPI, getProfile: () => string, read = readCardGet) {
  pi.registerCommand("name-codecks", {
    description: "Name this session from a Codecks card (usage: /name-codecks $abc)",
    handler: async (args, ctx) => {
      const code = normalizeCardCode(args, true);
      const seq = code ? cardCodeToAccountSeq(code) : null;
      if (!code || seq === null || !Number.isSafeInteger(seq)) {
        ctx.ui.notify("Usage: /name-codecks $<card-code> (or a bare card code).", "error");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const response = await runWithAbortSignal(undefined, () => read({ cardId: `$${code}`, format: "json" }), ctx.cwd, undefined, getProfile());
        const result = projectCardGetOutput(response.payload);
        if (ctx.sessionManager.getSessionId() !== sessionId) {
          ctx.ui.notify("Session changed during card lookup; no session was renamed.", "warning");
          return;
        }
        if (result.ok === false) {
          ctx.ui.notify(result.error.message, "error");
          return;
        }
        // The runtime schema validates title, whose dynamically built field is not inferred by TypeBox.
        const card = result.card as { title?: unknown };
        if (typeof card?.title !== "string" || !card.title.trim()) {
          ctx.ui.notify("Card has no title; session name unchanged.", "error");
          return;
        }
        const name = `[cdx:$${code}] ${card.title}`;
        pi.setSessionName(name);
        ctx.ui.notify(`Session named: ${name}`, "info");
      } catch {
        ctx.ui.notify("Codecks card lookup failed; session name unchanged.", "error");
      }
    },
  });
}

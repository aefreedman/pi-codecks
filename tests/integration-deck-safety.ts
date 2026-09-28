export type IntegrationDeckSnapshot = {
  id?: string | number;
  accountSeq?: number;
  title?: string;
  description?: string;
};

// Fail closed on missing/ambiguous deck metadata; no mutation can start without an exact Test baseline.
export function isExactTestDeck(deck: IntegrationDeckSnapshot | undefined, resolvedId: string | number): deck is IntegrationDeckSnapshot & { id: string | number; title: "Test"; description: string } {
  return deck?.id !== undefined && String(deck.id) === String(resolvedId)
    && deck.title === "Test" && typeof deck.description === "string";
}

export function classifyDeckDescriptionReadback(
  baseline: IntegrationDeckSnapshot & { id: string | number; title: "Test"; description: string },
  observed: IntegrationDeckSnapshot | undefined,
  temporaryDescription: string,
): "baseline" | "temporary" | "unsafe" {
  if (observed?.id === undefined || String(observed.id) !== String(baseline.id)
    || observed.title !== baseline.title || observed.accountSeq !== baseline.accountSeq
    || typeof observed.description !== "string") return "unsafe";
  if (observed.description === baseline.description) return "baseline";
  if (observed.description === temporaryDescription) return "temporary";
  return "unsafe";
}

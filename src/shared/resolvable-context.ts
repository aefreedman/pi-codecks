
export const normalizeResolvableContextInput = (
    value: unknown,
): { context: "comment" | "review" | "block"; label: string } | { error: string } =>
{
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw)
    {
        return { error: "Resolvable context is required." };
    }

    if (raw === "comment")
    {
        return { context: "comment", label: "comment" };
    }

    if (raw === "review")
    {
        return { context: "review", label: "review" };
    }

    if (raw === "block" || raw === "blocker" || raw === "blocked")
    {
        return { context: "block", label: "blocker" };
    }

    return { error: `Unknown context '${String(value ?? "")}'. Use comment, review, or blocker.` };
};

export type MutationTextError = { field: string; kind: "replacement_character" | "unpaired_surrogate"; utf16Offset: number; codePointOffset: number };

export const findMutationTextError = (field: string, value: unknown): MutationTextError | undefined =>
{
    if (typeof value !== "string") return undefined;
    let codePointOffset = 0;
    for (let utf16Offset = 0; utf16Offset < value.length; )
    {
        const codeUnit = value.charCodeAt(utf16Offset);
        if (codeUnit === 0xfffd)
        {
            return { field, kind: "replacement_character", utf16Offset, codePointOffset };
        }
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff)
        {
            const next = value.charCodeAt(utf16Offset + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
            {
                return { field, kind: "unpaired_surrogate", utf16Offset, codePointOffset };
            }
            utf16Offset += 2;
            codePointOffset += 1;
            continue;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)
        {
            return { field, kind: "unpaired_surrogate", utf16Offset, codePointOffset };
        }
        utf16Offset += 1;
        codePointOffset += 1;
    }
    return undefined;
};

export const validateMutationText = (values: Array<[string, unknown]>): string[] => values
    .map(([field, value]) => findMutationTextError(field, value))
    .filter((value): value is MutationTextError => value !== undefined)
    .map((error) => `${error.field} contains ${error.kind === "replacement_character" ? "Unicode replacement character U+FFFD" : "an unpaired UTF-16 surrogate"} at UTF-16 offset ${error.utf16Offset} (code-point offset ${error.codePointOffset}).`);

export class BoundedResponseError extends Error
{
    constructor(readonly category: "response_too_large" | "caller_aborted" | "request_timeout" | "invalid_response_stream", message: string)
    {
        super(message);
        this.name = "BoundedResponseError";
    }
}

/** Counts bytes from the decoded fetch stream; never trusts Content-Length or buffers an unbounded body. */
export const readBoundedResponse = async (response: Response, maxBytes: number, options: {
    signal?: AbortSignal;
    timeoutMs: number;
    schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): Promise<string> =>
{
    if (options.signal?.aborted) throw new BoundedResponseError("caller_aborted", "Codecks response read cancelled by caller.");
    if (response.body === null) return "";
    if (!response.body?.getReader) throw new BoundedResponseError("invalid_response_stream", "Codecks response has no readable stream.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    let completed = false;
    try
    {
        const interrupted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new BoundedResponseError("caller_aborted", "Codecks response read cancelled by caller."));
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted) onAbort();
            timer = (options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)))(
                () => reject(new BoundedResponseError("request_timeout", "Codecks response read timed out.")), options.timeoutMs);
            timer.unref?.();
        });
        while (true)
        {
            const next = await Promise.race([reader.read(), interrupted]);
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maxBytes) throw new BoundedResponseError("response_too_large", `Codecks batch response exceeded the ${maxBytes}-byte limit.`);
            chunks.push(next.value);
        }
        completed = true;
        return new TextDecoder().decode(Buffer.concat(chunks, bytes));
    }
    finally
    {
        if (timer) (options.cancel ?? clearTimeout)(timer);
        options.signal?.removeEventListener("abort", onAbort);
        // Cancellation itself can be hostile or stalled: it must not delay caller settlement.
        if (!completed) { try { void reader.cancel().catch(() => {}); } catch { /* preserve primary failure */ } }
        reader.releaseLock();
    }
};

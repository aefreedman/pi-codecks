import { randomUUID } from "node:crypto";

export type OnePasswordCredential = { token: string; providerId: "onepassword"; credentialGeneration: string };
type Flight = { controller: AbortController; promise: Promise<OnePasswordCredential>; waiters: number };
type Entry = {
    key: string; scope: string; epoch: number; current: boolean;
    cached?: { value: OnePasswordCredential; expiresAt: number; ttlMs: number };
    expiryTimer?: ReturnType<typeof setTimeout>;
    cooldownUntil: number; flights: Set<Flight>; shared?: Flight; ttlMs?: number;
};
export class OnePasswordStateError extends Error
{
    readonly retryable: boolean;
    constructor(readonly credentialCategory: string, message: string)
    {
        super(message);
        this.name = "OnePasswordStateError";
        this.retryable = credentialCategory === "credential_rate_limited";
    }
}
const cancelled = () => new OnePasswordStateError("credential_cancelled", "1Password credential retrieval cancelled.");
const rateLimited = () => new OnePasswordStateError("credential_rate_limited", "1Password rate-limited credential retrieval. Wait before retrying.");

/** Private process state. Keys never leave this object; local backoff is not provider retry timing. */
export class OnePasswordState
{
    private readonly entries = new Map<string, Entry>();
    private readonly active = new Map<string, Entry>();
    constructor(private readonly options: {
        now?: () => number;
        schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
        cancel?: (timer: ReturnType<typeof setTimeout>) => void;
    } = {}) {}
    private now(): number { return (this.options.now ?? Date.now)(); }
    private clearCached(entry: Entry): void
    {
        if (entry.expiryTimer !== undefined) (this.options.cancel ?? clearTimeout)(entry.expiryTimer);
        entry.expiryTimer = undefined;
        entry.cached = undefined;
    }
    private scheduleExpiry(entry: Entry, generation: string, ttlMs: number): void
    {
        // Capture only the generation, not the credential value, in the timer closure.
        entry.expiryTimer = (this.options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)))(() => {
            if (entry.cached?.value.credentialGeneration === generation) this.clearCached(entry);
        }, ttlMs);
        entry.expiryTimer.unref?.();
    }
    private invalidate(entry: Entry): void
    {
        entry.current = false;
        entry.epoch++;
        this.clearCached(entry);
        entry.shared = undefined;
    }
    private remove(entry: Entry): void
    {
        this.invalidate(entry);
        this.entries.delete(entry.key);
        if (this.active.get(entry.scope) === entry) this.active.delete(entry.scope);
    }
    private entry(key: string, scope: string): Entry
    {
        const previous = this.active.get(scope);
        if (previous && previous.key !== key) this.invalidate(previous);
        let entry = this.entries.get(key);
        if (!entry)
        {
            if (this.entries.size >= 64)
            {
                const removable = [...this.entries.values()].find(candidate => candidate.flights.size === 0 && candidate.cooldownUntil <= this.now());
                // Do not defeat active cooldowns by cycling through 65 configurations.
                if (!removable) throw new OnePasswordStateError("credential_capacity", "1Password credential retrieval is at its process-local capacity. Wait before retrying.");
                this.remove(removable);
            }
            entry = { key, scope, epoch: 0, current: true, cooldownUntil: 0, flights: new Set() };
            this.entries.set(key, entry);
        }
        entry.current = true;
        this.active.set(scope, entry);
        return entry;
    }
    private isCurrent(entry: Entry, epoch: number): boolean
    {
        return entry.current && entry.epoch === epoch && this.entries.get(entry.key) === entry && this.active.get(entry.scope) === entry;
    }
    private start(entry: Entry, ttlMs: number, load: (signal: AbortSignal) => Promise<{ token: string }>): Flight
    {
        const epoch = entry.epoch;
        const controller = new AbortController();
        const flight: Flight = { controller, waiters: 0, promise: undefined! };
        entry.flights.add(flight);
        flight.promise = Promise.resolve().then(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort = () => {};
            try
            {
                const interrupted = new Promise<never>((_resolve, reject) => {
                    onAbort = () => reject(cancelled());
                    controller.signal.addEventListener("abort", onAbort, { once: true });
                    if (controller.signal.aborted) onAbort();
                    timer = (this.options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)))(() => {
                        reject(new OnePasswordStateError("credential_helper_timeout", "1Password credential retrieval timed out."));
                        controller.abort();
                    }, 15_000);
                    timer.unref?.();
                });
                const loaded = Promise.resolve().then(() => {
                    if (controller.signal.aborted) throw cancelled();
                    return load(controller.signal);
                });
                const credential = await Promise.race([loaded, interrupted]);
                if (controller.signal.aborted) throw cancelled();
                const value: OnePasswordCredential = { token: credential.token, providerId: "onepassword", credentialGeneration: randomUUID() };
                if (ttlMs > 0 && this.isCurrent(entry, epoch) && entry.cooldownUntil <= this.now())
                {
                    this.clearCached(entry);
                    entry.cached = { value, expiresAt: this.now() + ttlMs, ttlMs };
                    this.scheduleExpiry(entry, value.credentialGeneration, ttlMs);
                }
                return value;
            }
            catch (error)
            {
                if (!controller.signal.aborted && typeof error === "object" && error !== null && (error as { credentialCategory?: unknown }).credentialCategory === "credential_rate_limited"
                    && this.entries.get(entry.key) === entry)
                {
                    // A positive result still applies to this exact configuration after a scope switch.
                    entry.cooldownUntil = Math.max(entry.cooldownUntil, this.now() + 60_000);
                    entry.epoch++;
                    this.clearCached(entry);
                    entry.shared = undefined;
                }
                throw error;
            }
            finally
            {
                if (timer) (this.options.cancel ?? clearTimeout)(timer);
                controller.signal.removeEventListener("abort", onAbort);
                entry.flights.delete(flight);
                if (entry.shared === flight) entry.shared = undefined;
            }
        });
        return flight;
    }
    private wait(flight: Flight, signal: AbortSignal): Promise<OnePasswordCredential>
    {
        flight.waiters++;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown, value?: OnePasswordCredential) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                flight.waiters--;
                if (error !== undefined) reject(error); else resolve(value!);
            };
            const onAbort = () => {
                finish(cancelled());
                if (flight.waiters === 0) flight.controller.abort();
            };
            signal.addEventListener("abort", onAbort, { once: true });
            flight.promise.then(value => finish(undefined, value), error => finish(error));
            if (signal.aborted) onAbort();
        });
    }
    resolve(key: string, scope: string, ttlMs: number, signal: AbortSignal, load: (signal: AbortSignal) => Promise<{ token: string }>): Promise<OnePasswordCredential>
    {
        if (signal.aborted) return Promise.reject(cancelled());
        try
        {
            const entry = this.entry(key, scope);
            if (entry.cooldownUntil > this.now()) throw rateLimited();
            entry.cooldownUntil = 0;
            if (entry.ttlMs !== undefined && entry.ttlMs !== ttlMs)
            {
                entry.epoch++;
                entry.shared = undefined;
                this.clearCached(entry);
            }
            entry.ttlMs = ttlMs;
            if (entry.cached && (entry.cached.expiresAt <= this.now() || entry.cached.ttlMs !== ttlMs)) this.clearCached(entry);
            if (ttlMs > 0 && entry.cached) return Promise.resolve(entry.cached.value);
            const flight = ttlMs > 0 && entry.shared && !entry.shared.controller.signal.aborted ? entry.shared : this.start(entry, ttlMs, load);
            if (ttlMs > 0) entry.shared = flight;
            return this.wait(flight, signal);
        }
        catch (error) { return Promise.reject(error); }
    }
    evict(generation: unknown): void
    {
        if (typeof generation !== "string") return;
        for (const entry of this.entries.values())
        {
            if (entry.cached?.value.credentialGeneration === generation)
            {
                this.clearCached(entry);
                entry.epoch++;
                entry.shared = undefined;
            }
        }
    }
    clear(): void
    {
        for (const entry of this.entries.values())
        {
            this.invalidate(entry);
            for (const flight of entry.flights) flight.controller.abort();
        }
        this.entries.clear();
        this.active.clear();
    }
    counts(): { entries: number; cacheEntries: number; cooldownEntries: number; inFlight: number }
    {
        const entries = [...this.entries.values()];
        return { entries: entries.length, cacheEntries: entries.filter(e => !!e.cached).length,
            cooldownEntries: entries.filter(e => e.cooldownUntil > this.now()).length, inFlight: entries.reduce((sum, e) => sum + e.flights.size, 0) };
    }
}

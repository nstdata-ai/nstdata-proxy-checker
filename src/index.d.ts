export interface CheckOptions {
    targetURL: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    caFile?: string;
    expectedText?: string;
    signal?: AbortSignal;
    ipProbeURL?: string;
    lookupIp?: (ip: string, options: { timeoutMs: number; maxResponseBytes: number; signal: AbortSignal }) => Promise<unknown>;
}
export interface IpSummary {
    source: string;
    retrievedAt: string;
    sourceUpdatedAt: string | null;
    cached: boolean;
    information: {
        query: string;
        country?: string | null; countryCode?: string | null;
        region?: string | null; regionName?: string | null; city?: string | null;
        timezone?: string | null; isp?: string | null; org?: string | null;
        as?: string | null; asname?: string | null;
        mobile?: boolean | null; proxy?: boolean | null; hosting?: boolean | null;
    };
}
export interface CheckResult {
    ok: boolean;
    protocol?: 'http' | 'https' | null;
    probeRequested: boolean;
    statusCode: number | null;
    elapsedMs: number | null;
    observedIp: string | null;
    contentMatched?: boolean | null;
    error?: { code: string };
    ip?: {
        source: 'target-response' | 'separate-probe';
        observedIp: string | null;
        probe?: CheckResult;
        lookup?: { ok: true; requested: true; result: IpSummary } |
            { ok: false; requested: boolean; error: { code: string; statusCode?: number; apiCode?: number } };
    };
}
export interface BatchOptions extends CheckOptions {
    concurrency?: number;
    invalidInput?: 'reject' | 'report';
}
export class ProxyCheckError extends Error {
    constructor(code: string);
    readonly code: string;
}
export function checkProxy(proxyURL: string, options: CheckOptions): Promise<CheckResult>;
export function checkProxies(proxies: readonly unknown[], options: BatchOptions): Promise<{
    results: Array<CheckResult & { index: number }>;
    total: number;
    succeeded: number;
    failed: number;
}>;

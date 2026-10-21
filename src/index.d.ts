export interface CheckOptions {
    targetURL: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    caFile?: string;
    expectedText?: string;
    signal?: AbortSignal;
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

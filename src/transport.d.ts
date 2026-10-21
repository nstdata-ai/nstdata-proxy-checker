import type { IncomingHttpHeaders } from 'node:http';

export interface ProxyTransportOptions {
    proxyURL: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    caFile?: string;
}
export interface ProxyRequest {
    url: string;
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
}
export interface ProxyResponse {
    statusCode: number;
    /** Complete decoded bytes, bounded by maxResponseBytes. Untrusted and unredacted. */
    body: Buffer;
    headers: IncomingHttpHeaders;
}
export class ProxyTransportError extends Error {
    constructor(code: string, message: string, details?: Record<string, unknown>);
    readonly code: string;
    readonly details: Record<string, unknown>;
}
export function createProxyTransport(options: ProxyTransportOptions): {
    request(input: ProxyRequest, options?: { signal?: AbortSignal }): Promise<ProxyResponse>;
};

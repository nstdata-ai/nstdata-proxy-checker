import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isAbsolute } from 'node:path';

const reserved = new Set(['host', 'connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'keep-alive']);

export function validateSettings({ proxyURL, timeoutMs = 20000, maxResponseBytes = 1048576, caFile }) {
    if (typeof proxyURL !== 'string' || proxyURL.length > 8192) throw new Error();
    const gateway = new URL(proxyURL);
    decodeURIComponent(gateway.username); decodeURIComponent(gateway.password);
    if (!['http:', 'https:'].includes(gateway.protocol) || gateway.pathname !== '/' || gateway.search || gateway.hash) throw new Error();
    for (const [value, min, max] of [[timeoutMs, 1, 600000], [maxResponseBytes, 256, 67108864]]) {
        if (!['number', 'string'].includes(typeof value) || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error();
    }
    if (caFile !== undefined && (typeof caFile !== 'string' || !caFile.length || caFile.length > 4096 || !isAbsolute(caFile))) throw new Error();
    return { proxyURL, timeoutMs: Number(timeoutMs), maxResponseBytes: Number(maxResponseBytes), caFile };
}

export function validateRequest(input) {
    if (!input || typeof input.url !== 'string' || input.url.length > 8192) throw new Error();
    const target = new URL(input.url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
    const method = input.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) throw new Error();
    let headers;
    if (input.headers !== undefined) {
        if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new Error();
        headers = { ...input.headers };
        if (Object.keys(headers).length > 100) throw new Error();
        for (const [key, value] of Object.entries(headers)) {
            if (!key.length || key.length > 256 || typeof value !== 'string' || value.length > 8192 || reserved.has(key.toLowerCase())) throw new Error();
            validateHeaderName(key); validateHeaderValue(key, value);
        }
    }
    return { url: target.href, method, headers };
}

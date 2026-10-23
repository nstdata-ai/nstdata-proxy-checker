import { createProxyTransport, ProxyTransportError } from './transport.js';
import { validateSettings, validateRequest, proxySecrets } from './config.js';
import { isIP } from 'node:net';
import { isUtf8 } from 'node:buffer';
import { addIpDiagnostics, validateIpOptions } from './ip.js';

export class ProxyCheckError extends Error {
    constructor(code) { super(`Proxy check failed: ${code}`); this.name = 'ProxyCheckError'; this.code = code; }
}

function configuration(proxyURL, options = {}) {
    try {
        const { targetURL, expectedText, signal } = options;
        if (expectedText !== undefined && (typeof expectedText !== 'string' || expectedText.length === 0 || Buffer.byteLength(expectedText) > 4096)) throw new Error();
        if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
        validateIpOptions(options);
        const config = validateSettings({ ...options, proxyURL });
        const request = validateRequest({ url: targetURL });
        return { ...config, targetURL: request.url };
    } catch { throw new ProxyCheckError('INVALID_CONFIG'); }
}

/** Optional IP diagnostics leave the target check and its result unchanged. */
export async function checkProxy(proxyURL, options = {}) {
    const snapshot = { ...options };
    const result = await checkOnce(proxyURL, snapshot);
    return addIpDiagnostics(result, proxyURL, snapshot, checkOnce);
}

/** One local probe through the configured gateway; no hosted checker or Crawl key. */
async function checkOnce(proxyURL, options = {}) {
    const config = configuration(proxyURL, options);
    const { expectedText, signal } = options;
    const assessContent = expectedText !== undefined;
    const gateway = new URL(proxyURL);
    const empty = { ok: false, protocol: gateway.protocol.slice(0, -1), statusCode: null, elapsedMs: null, observedIp: null,
        ...(assessContent ? { contentMatched: null } : {}) };
    if (signal?.aborted) return { ...empty, probeRequested: false, error: { code: 'CANCELLED' } };
    let transport;
    try { transport = createProxyTransport(config); } catch {
        return { ...empty, probeRequested: false, error: { code: 'INVALID_CONFIG' } };
    }
    let probeRequested = false;
    try {
        const started = performance.now();
        probeRequested = true;
        const response = await transport.request({ url: config.targetURL }, { signal });
        const elapsedMs = performance.now() - started;
        const body = response.body.toString('utf8');
        const secrets = proxySecrets(proxyURL);
        const sensitive = value => secrets.some(secret => secret && value.includes(secret));
        // Bound assertion assessment separately from the transport response-size limit.
        const envelope = { statusCode: response.statusCode, encoding: 'utf-8', body,
            headers: { 'content-type': response.headers['content-type'], location: response.headers.location, 'retry-after': response.headers['retry-after'] } };
        if (assessContent && JSON.stringify(envelope).length > 16000) {
            return { ...empty, probeRequested, statusCode: response.statusCode, elapsedMs,
                error: { code: response.statusCode < 200 || response.statusCode >= 300 ? 'TARGET_HTTP_ERROR' : 'OUTPUT_LIMIT' } };
        }
        let address = body.trim();
        try {
            const json = JSON.parse(address);
            address = json?.ip ?? (json?.code === 200 && json?.err === false ? json.data?.ip : undefined);
        } catch { /* Plain IP responses are also supported. */ }
        const observedIp = typeof address === 'string' && isIP(address) && !sensitive(address) ? address : null;
        const contentUnavailable = assessContent && (!isUtf8(response.body) || body.includes('<REDACTED>') || sensitive(body));
        const contentMatched = assessContent && !contentUnavailable ? body.includes(expectedText) : null;
        const errorCode = response.statusCode < 200 || response.statusCode >= 300 ? 'TARGET_HTTP_ERROR'
            : contentUnavailable ? 'CONTENT_UNAVAILABLE' : contentMatched === false ? 'CONTENT_MISMATCH' : null;
        return { ok: errorCode === null, protocol: empty.protocol, probeRequested, statusCode: response.statusCode,
            elapsedMs, observedIp, ...(assessContent ? { contentMatched } : {}), ...(errorCode ? { error: { code: errorCode } } : {}) };
    } catch (error) {
        return { ...empty, probeRequested, error: { code: signal?.aborted ? 'CANCELLED'
            : error instanceof ProxyTransportError ? error.code : 'CHECK_FAILED' } };
    }
}

export async function checkProxies(proxies, { concurrency = 1, invalidInput = 'reject', ...options } = {}) {
    if (!Array.isArray(proxies) || proxies.length < 1 || proxies.length > 100 ||
        !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
        !['reject', 'report'].includes(invalidInput)) throw new ProxyCheckError('INVALID_CONFIG');
    const entries = Array.from(proxies), results = new Array(entries.length);
    // Validate shared options even when every input proxy is invalid; this URL is never requested.
    configuration('http://127.0.0.1:1', options);
    for (let index = 0; index < entries.length; index++) {
        try { configuration(entries[index], options); } catch (error) {
            if (invalidInput === 'reject') throw error;
            results[index] = { index, ok: false, protocol: null, probeRequested: false, statusCode: null, elapsedMs: null,
                observedIp: null, ...(options.expectedText !== undefined ? { contentMatched: null } : {}), error: { code: 'INVALID_CONFIG' } };
        }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
        while (next < entries.length && !options.signal?.aborted) {
            const index = next++;
            if (!results[index]) results[index] = { index, ...await checkProxy(entries[index], options) };
        }
    }));
    for (let index = 0; index < results.length; index++) {
        results[index] ??= { index, ok: false, probeRequested: false, statusCode: null, elapsedMs: null,
            observedIp: null, ...(options.expectedText !== undefined ? { contentMatched: null } : {}), error: { code: 'CANCELLED' } };
    }
    return { results, total: results.length, succeeded: results.filter(x => x.ok).length,
        failed: results.filter(x => !x.ok).length };
}

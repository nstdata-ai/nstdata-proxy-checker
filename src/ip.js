import { isIP } from 'node:net';
import { validateRequest, proxySecrets } from './config.js';

export function validateIpOptions({ ipProbeURL, lookupIp }) {
    if (ipProbeURL !== undefined) validateRequest({ url: ipProbeURL });
    if (lookupIp !== undefined && typeof lookupIp !== 'function') throw new Error();
}

function summary(value, ip, proxyURL) {
    const canonical = address => isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
    const data = value?.information;
    if (!data || typeof data.query !== 'string' || !isIP(data.query) || canonical(data.query) !== canonical(ip) ||
        typeof value.source !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.source) ||
        typeof value.retrievedAt !== 'string' || value.retrievedAt.length > 40 || !Number.isFinite(Date.parse(value.retrievedAt)) ||
        (value.sourceUpdatedAt !== null && (typeof value.sourceUpdatedAt !== 'string' || value.sourceUpdatedAt.length > 40 || !Number.isFinite(Date.parse(value.sourceUpdatedAt)))) ||
        typeof value.cached !== 'boolean') throw new Error();
    const information = { query: data.query };
    for (const name of ['country', 'countryCode', 'region', 'regionName', 'city', 'timezone', 'isp', 'org', 'as', 'asname']) {
        if (data[name] === undefined) continue;
        if (data[name] !== null && (typeof data[name] !== 'string' || data[name].length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(data[name]))) throw new Error();
        information[name] = data[name];
    }
    for (const name of ['mobile', 'proxy', 'hosting']) {
        if (data[name] === undefined) continue;
        if (data[name] !== null && typeof data[name] !== 'boolean') throw new Error();
        information[name] = data[name];
    }
    const result = { source: value.source, information, retrievedAt: new Date(value.retrievedAt).toISOString(),
        sourceUpdatedAt: value.sourceUpdatedAt === null ? null : new Date(value.sourceUpdatedAt).toISOString(), cached: value.cached };
    const secrets = proxySecrets(proxyURL);
    const serialized = JSON.stringify(result);
    const strings = [result.source, ...Object.values(information)].filter(value => typeof value === 'string');
    if (serialized.length > 16000 || strings.some(value => secrets.some(secret => secret && value.includes(secret)))) throw new Error();
    return result;
}

export async function addIpDiagnostics(result, proxyURL, options, probe) {
    const { ipProbeURL, lookupIp, signal, timeoutMs = 20000, maxResponseBytes = 1048576 } = options;
    if (ipProbeURL === undefined && lookupIp === undefined) return result;
    const observed = ipProbeURL === undefined ? result : await probe(proxyURL, {
        targetURL: ipProbeURL, timeoutMs, maxResponseBytes, caFile: options.caFile, signal,
    });
    const ip = { source: ipProbeURL === undefined ? 'target-response' : 'separate-probe',
        observedIp: observed.statusCode >= 200 && observed.statusCode < 300 ? observed.observedIp : null,
        ...(ipProbeURL === undefined ? {} : { probe: observed }) };
    if (lookupIp === undefined) return { ...result, ip };
    if (!ip.observedIp) return { ...result, ip: { ...ip, lookup: { ok: false, requested: false, error: { code: 'IP_NOT_OBSERVED' } } } };
    if (signal?.aborted) return { ...result, ip: { ...ip, lookup: { ok: false, requested: false, error: { code: 'CANCELLED' } } } };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Number(timeoutMs));
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let onAbort, requested = false;
    try {
        // Bound custom lookup adapters too, even when they ignore the supplied signal.
        const stopped = new Promise((_, reject) => { onAbort = () => reject(new Error()); active.addEventListener('abort', onAbort, { once: true }); });
        const value = await Promise.race([Promise.resolve().then(() => {
            if (active.aborted) throw new Error();
            requested = true;
            return lookupIp(ip.observedIp, { signal: active, timeoutMs: Number(timeoutMs), maxResponseBytes: Number(maxResponseBytes) });
        }), stopped]);
        if (active.aborted) throw new Error();
        const details = summary(value, ip.observedIp, proxyURL);
        return { ...result, ip: { ...ip, lookup: { ok: true, requested: true, result: details } } };
    } catch (error) {
        const allowed = ['INVALID_IP', 'INVALID_CONFIG', 'HTTP_ERROR', 'API_ERROR', 'TIMEOUT', 'CANCELLED', 'NETWORK_ERROR', 'RESPONSE_LIMIT', 'INVALID_RESPONSE'];
        const code = signal?.aborted ? 'CANCELLED' : active.aborted ? 'TIMEOUT' : allowed.includes(error?.code) ? error.code : 'IP_LOOKUP_FAILED';
        const details = { code };
        if (['HTTP_ERROR', 'API_ERROR'].includes(code) && Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) details.statusCode = error.statusCode;
        if (code === 'API_ERROR' && Number.isSafeInteger(error.apiCode)) details.apiCode = error.apiCode;
        return { ...result, ip: { ...ip, lookup: { ok: false, requested, error: details } } };
    } finally { clearTimeout(timer); active.removeEventListener('abort', onAbort); }
}

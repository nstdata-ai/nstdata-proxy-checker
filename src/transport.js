import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { connect as connectTLS } from 'node:tls';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { validateSettings, validateRequest } from './config.js';
export class ProxyTransportError extends Error {
    constructor(code, message, details = {}) { super(message); this.name = 'ProxyTransportError'; this.code = code; this.details = details; }
}

/** Validated HTTP(S) gateway transport. Returned body/headers are untrusted and unredacted. */
export function createProxyTransport(settings) {
    let config, ca;
    try {
        config = validateSettings(settings);
        if (config.caFile) {
            const file = statSync(config.caFile);
            if (!file.isFile() || file.size > 1048576) throw new Error();
            const certificates = readFileSync(config.caFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
            if (!certificates?.length) throw new Error();
            for (const certificate of certificates) new X509Certificate(certificate);
            ca = [...getCACertificates('default'), ...certificates];
        }
    } catch {
        throw new ProxyTransportError('INVALID_CONFIG', 'Invalid proxy transport configuration.');
    }
    return {
        async request(input, { signal } = {}) {
            let request;
            try {
                request = validateRequest(input);
                if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
            } catch { throw new ProxyTransportError('INVALID_CONFIG', 'Invalid proxy request.'); }
            const controller = new AbortController();
            const abort = () => controller.abort(new DOMException('Local request stopped', signal?.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException('Proxy deadline exceeded', 'TimeoutError')), config.timeoutMs);
            try {
                return await requestThroughProxy(config.proxyURL, request, controller.signal, config.maxResponseBytes, ca);
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new ProxyTransportError(controller.signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', 'Local proxy request stopped. No retry was performed.');
                }
                if (error instanceof ProxyTransportError) throw error;
                throw new ProxyTransportError('UPSTREAM_ERROR', 'The proxy request failed. No retry was performed.');
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            }
        },
    };
}
const decoders = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };
const responseLimit = () => new ProxyTransportError('RESPONSE_LIMIT', 'The proxy response exceeds the configured byte limit. No automatic retry was performed.');
async function requestThroughProxy(proxyURL, input, signal, maxBytes, ca) {
    const target = new URL(input.url);
    const gateway = new URL(proxyURL);
    const username = decodeURIComponent(gateway.username), password = decodeURIComponent(gateway.password);
    gateway.username = '';
    gateway.password = '';
    const auth = username || password ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {};
    const gatewayClient = gateway.protocol === 'https:' ? https : http;
    const authority = `${target.hostname}:${target.port || 443}`;
    let tunnel;
    let request;
    let pendingConnect;
    let rejectPending;
    const abort = () => {
        rejectPending?.(signal.reason);
        pendingConnect?.destroy();
        request?.destroy();
        tunnel?.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        signal.throwIfAborted();
        if (target.protocol === 'https:') {
            tunnel = await new Promise((resolve, reject) => {
                rejectPending = reject;
                let responded = false;
                const connect = gatewayClient.request(gateway, { method: 'CONNECT', path: authority,
                    headers: { Host: authority, ...auth }, agent: false, signal, ca, rejectUnauthorized: true, maxHeaderSize: 16384 });
                pendingConnect = connect;
                connect.once('error', reject);
                connect.once('close', () => { if (!responded)
                    reject(new ProxyTransportError('INVALID_RESPONSE', 'The proxy closed before establishing a tunnel.')); });
                connect.once('upgrade', (_response, socket) => {
                    responded = true;
                    socket.destroy();
                    reject(new ProxyTransportError('UNSUPPORTED_RESPONSE', 'HTTP protocol upgrades are not supported.'));
                });
                connect.once('response', response => {
                    responded = true;
                    response.destroy();
                    connect.destroy();
                    reject(new ProxyTransportError('INVALID_RESPONSE', 'The proxy did not establish a CONNECT tunnel.'));
                });
                connect.once('connect', (response, socket, head) => {
                    responded = true;
                    if (response.statusCode !== 200) {
                        socket.destroy();
                        connect.destroy();
                        reject(response.statusCode === 407
                            ? new ProxyTransportError('PROXY_AUTHORIZATION_FAILED', 'The proxy rejected authentication. No retry was performed.', { statusCode: 407 })
                            : new ProxyTransportError('PROXY_CONNECT_FAILED', 'The proxy rejected the CONNECT tunnel.', { statusCode: response.statusCode }));
                        return;
                    }
                    if (head.length)
                        socket.unshift(head);
                    resolve(socket);
                });
                connect.end();
            });
            signal.throwIfAborted();
        }
        return await new Promise((resolve, reject) => {
            rejectPending = reject;
            let responded = false;
            const requestOptions = { method: input.method, signal, ca, rejectUnauthorized: true, maxHeaderSize: 16384,
                headers: { 'Accept-Encoding': 'identity', ...input.headers },
            };
            let endpoint;
            let client;
            if (tunnel) {
                endpoint = target;
                client = https;
                const socket = tunnel;
                const hostname = target.hostname.replace(/^\[|\]$/g, '');
                requestOptions.createConnection = () => connectTLS({ socket, host: hostname, ca, rejectUnauthorized: true, servername: isIP(hostname) ? undefined : hostname });
            }
            else {
                endpoint = gateway;
                client = gatewayClient;
                target.hash = '';
                requestOptions.agent = false;
                requestOptions.path = target.href;
                requestOptions.headers = { ...requestOptions.headers, Host: target.host, ...auth };
            }
            request = client.request(endpoint, requestOptions, async (response) => {
                responded = true;
                try {
                    if (!tunnel && response.statusCode === 407)
                        throw new ProxyTransportError('PROXY_AUTHORIZATION_FAILED', 'The proxy rejected authentication. No retry was performed.', { statusCode: 407 });
                    if (input.method !== 'HEAD' && Number(response.headers['content-length']) > maxBytes)
                        throw responseLimit();
                    const chunks = [];
                    let size = 0;
                    for await (const chunk of response) {
                        size += chunk.length;
                        if (size > maxBytes)
                            throw responseLimit();
                        chunks.push(chunk);
                    }
                    let body = Buffer.concat(chunks);
                    const encoding = response.headers['content-encoding']?.trim().toLowerCase();
                    if (body.length && encoding && encoding !== 'identity') {
                        if (!Object.hasOwn(decoders, encoding))
                            throw new ProxyTransportError('UNSUPPORTED_ENCODING', 'Unsupported HTTP content encoding.');
                        try {
                            body = await decoders[encoding](body, { maxOutputLength: maxBytes });
                        }
                        catch (error) {
                            if (error.code === 'ERR_BUFFER_TOO_LARGE')
                                throw responseLimit();
                            throw new ProxyTransportError('INVALID_RESPONSE', 'Unable to decode the proxy response.');
                        }
                    }
                    signal.throwIfAborted();
                    resolve({ statusCode: response.statusCode ?? 0, body, headers: response.headers });
                }
                catch (error) {
                    reject(error);
                }
                finally {
                    response.destroy();
                }
            });
            request.once('error', reject);
            request.once('close', () => { if (!responded)
                reject(new ProxyTransportError('INVALID_RESPONSE', 'The connection closed before returning a response.')); });
            request.once('upgrade', (_response, socket) => {
                responded = true;
                socket.destroy();
                reject(new ProxyTransportError('UNSUPPORTED_RESPONSE', 'HTTP protocol upgrades are not supported.'));
            });
            request.end();
        });
    }
    catch (error) {
        const code = error?.code ?? '';
        if (code === 'HPE_HEADER_OVERFLOW')
            throw new ProxyTransportError('RESPONSE_LIMIT', 'Response headers exceed the 16 KiB limit.');
        if (/CERT|^ERR_TLS_|^EPROTO$/.test(code))
            throw new ProxyTransportError('TLS_ERROR', 'TLS verification or handshake failed. Check the trusted CA and hostname.');
        throw error;
    }
    finally {
        signal.removeEventListener('abort', abort);
        pendingConnect?.destroy();
        request?.destroy();
        tunnel?.destroy();
    }
}

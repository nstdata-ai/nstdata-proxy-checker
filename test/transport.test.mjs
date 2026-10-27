import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tlsMaterial, listen, proxyFixture } from './proxy-fixtures.mjs';

const root = process.env.NSTDATA_CHECKER_ROOT ? pathToFileURL(resolve(process.env.NSTDATA_CHECKER_ROOT) + '/') : new URL('../', import.meta.url);
const { checkProxy } = await import(new URL('src/index.js', root));
const { createProxyTransport, ProxyTransportError } = await import(new URL('src/transport.js', root));

test('transport validates destinations, headers and settings before proxy traffic', async t => {
    let count = 0;
    const port = await listen(t, http.createServer((_req, res) => { count++; res.end(); }));
    const proxyURL = `http://127.0.0.1:${port}`;
    for (const settings of [{ proxyURL: 'socks5://localhost:1' }, { proxyURL, timeoutMs: 0 }, { proxyURL, maxResponseBytes: 255 }, { proxyURL, caFile: '/missing-fixture.pem' }]) {
        assert.throws(() => createProxyTransport(settings), { code: 'INVALID_CONFIG' });
    }
    const transport = createProxyTransport({ proxyURL });
    for (const input of [{ url: 'file:///etc/passwd' }, { url: 'https://u:p@target.invalid' },
        { url: 'http://target.invalid', method: 'POST' }, { url: 'http://target.invalid', headers: { 'Proxy-Authorization': 'secret' } },
        { url: 'http://target.invalid', headers: { Host: 'override.invalid' } }, { url: 'http://target.invalid', headers: { X: 'bad\r\nheader' } }]) {
        await assert.rejects(transport.request(input), { code: 'INVALID_CONFIG' });
    }
    assert.equal(count, 0);
});

test('transport preserves raw bytes, HEAD, redirect status and decoded byte cap', async t => {
    const requests = [];
    const port = await listen(t, http.createServer((req, res) => {
        requests.push(req.url);
        if (req.url.endsWith('/redirect')) { res.writeHead(302, { Location: 'http://never-request.invalid/' }); return res.end(); }
        if (req.url.endsWith('/gzip')) { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(gzipSync('x'.repeat(2000))); }
        res.end(Buffer.from([0, 255, 1]));
    }));
    const transport = createProxyTransport({ proxyURL: `http://127.0.0.1:${port}`, maxResponseBytes: 256 });
    assert.deepEqual((await transport.request({ url: 'http://target.invalid/bytes' })).body, Buffer.from([0, 255, 1]));
    assert.equal((await transport.request({ url: 'http://target.invalid/bytes', method: 'HEAD' })).body.length, 0);
    assert.equal((await transport.request({ url: 'http://target.invalid/redirect' })).statusCode, 302);
    await assert.rejects(transport.request({ url: 'http://target.invalid/gzip' }), { code: 'RESPONSE_LIMIT' });
    assert.equal(requests.length, 4);
});

test('HTTP/HTTPS gateways verify target and gateway TLS, and isolate authentication', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t);
    const received = [];
    const port = await listen(t, https.createServer(material, (req, res) => { received.push(req.headers); res.end('trusted'); }));
    for (const tls of [undefined, material]) {
        const proxy = await proxyFixture(t, { tls });
        const transport = createProxyTransport({ proxyURL: proxy.url, caFile: material.certFile });
        assert.equal((await transport.request({ url: `https://localhost:${port}/` })).body.toString(), 'trusted');
        assert.match(proxy.connections[0].headers['proxy-authorization'], /^Basic /);
        assert.equal(received.at(-1)['proxy-authorization'], undefined);
        await assert.rejects(transport.request({ url: `https://127.0.0.2:${port}/` }), { code: 'TLS_ERROR' });
        await assert.rejects(createProxyTransport({ proxyURL: proxy.url }).request({ url: `https://localhost:${port}/` }), { code: 'TLS_ERROR' });
    }
    assert.equal(received.length, 2);
});

test('cancellation and deadline stop pending CONNECT; errors contain no credentials', async t => {
    let connecting;
    const started = new Promise(resolve => { connecting = resolve; });
    const proxy = await proxyFixture(t, { hangConnect: true, onConnect: connecting });
    const transport = createProxyTransport({ proxyURL: proxy.url, timeoutMs: 50 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = transport.request({ url: 'https://target.invalid' });
    const rejected = assert.rejects(pending, error => {
        assert.ok(error instanceof ProxyTransportError); assert.equal(error.code, 'TIMEOUT');
        assert.doesNotMatch(String(error) + JSON.stringify(error), /fixture-user|fixture-password|target\.invalid/); return true;
    });
    await started;
    t.mock.timers.tick(50);
    await rejected;
    assert.equal(proxy.connections.length, 1);
    await proxy.connections[0].closed;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(transport.request({ url: 'https://target.invalid' }, { signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(proxy.connections.length, 1);
});

test('an HTTPS target 407 stays target data after an authenticated CONNECT', { timeout: 10000 }, async t => {
    const material = tlsMaterial(t), received = [];
    const port = await listen(t, https.createServer(material, (req, res) => {
        received.push(req.headers);
        res.writeHead(407); res.end('private target diagnostic');
    }));
    const proxy = await proxyFixture(t);
    const url = `https://localhost:${port}/`;
    const transport = createProxyTransport({ proxyURL: proxy.url, caFile: material.certFile });
    const raw = await transport.request({ url });
    assert.equal(raw.statusCode, 407);
    assert.equal(raw.body.toString(), 'private target diagnostic');
    const result = await checkProxy(proxy.url, { targetURL: url, caFile: material.certFile });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 407);
    assert.equal(result.error.code, 'TARGET_HTTP_ERROR');
    assert.ok(result.elapsedMs >= 0);
    assert.equal(received.length, 2);
    assert.equal(proxy.connections.length, 2);
    assert.ok(received.every(headers => headers['proxy-authorization'] === undefined));
    assert.ok(proxy.connections.every(connection => /^Basic /.test(connection.headers['proxy-authorization'])));
    assert.doesNotMatch(JSON.stringify(result), /private target diagnostic|fixture-user|fixture-password/);
});


test('an incomplete gateway certificate chain is a TLS error', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t, { missingIntermediate: true });
    const port = await listen(t, https.createServer(material, (_req, res) => res.end('must not be read')));
    const proxyURL = `https://localhost:${port}`;
    const options = { proxyURL, caFile: material.certFile };
    await assert.rejects(createProxyTransport(options).request({ url: 'http://target.invalid/' }), { code: 'TLS_ERROR' });
    const result = await checkProxy(proxyURL, { targetURL: 'http://target.invalid/', caFile: material.certFile });
    assert.equal(result.error.code, 'TLS_ERROR');
    assert.equal(result.statusCode, null);
    assert.equal(result.elapsedMs, null);
});


test('CONNECT accepts every successful 2xx tunnel status and rejects non-success responses', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t), received = [];
    const port = await listen(t, https.createServer(material, (req, res) => {
        received.push(req.headers);
        res.end('tunneled response');
    }));
    const url = `https://localhost:${port}/`;
    for (const tls of [undefined, material]) {
        for (const successStatus of [200, 201, 204, 299]) {
            const proxy = await proxyFixture(t, { tls, successStatus });
            const transport = createProxyTransport({ proxyURL: proxy.url, caFile: material.certFile });
            const result = await transport.request({ url });
            assert.equal(result.statusCode, 200, 'Expose the target HTTP status, not the CONNECT status');
            assert.equal(result.body.toString(), 'tunneled response');
            assert.equal(proxy.connections.length, 1);
            assert.match(proxy.connections[0].headers['proxy-authorization'], /^Basic /);
            assert.equal(received.at(-1)['proxy-authorization'], undefined);
        }
    }
    assert.equal(received.length, 8);
    for (const connectStatus of [300, 407, 502]) {
        const proxy = await proxyFixture(t, { connectStatus });
        const transport = createProxyTransport({ proxyURL: proxy.url, caFile: material.certFile });
        await assert.rejects(transport.request({ url }), { code: connectStatus === 407 ? 'PROXY_AUTHORIZATION_FAILED' : 'PROXY_CONNECT_FAILED' });
        assert.equal(proxy.connections.length, 1);
    }
    assert.equal(received.length, 8, 'Rejected CONNECT responses must not reach the target');
});


test('gzip, deflate and Brotli preserve content and enforce decoded byte limits', async t => {
    const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
    let requests = 0;
    const port = await listen(t, http.createServer((req, res) => {
        requests++;
        const [encoding, mode] = new URL(req.url).pathname.slice(1).split('/');
        res.writeHead(200, { 'Content-Encoding': encoding });
        res.end(mode === 'invalid' ? Buffer.from('invalid compressed bytes')
            : encoders[encoding](mode === 'large' ? 'x'.repeat(2000) : 'decoded content'));
    }));
    const transport = createProxyTransport({ proxyURL: `http://127.0.0.1:${port}`, maxResponseBytes: 256 });
    for (const encoding of Object.keys(encoders)) {
        assert.equal((await transport.request({ url: `http://target.invalid/${encoding}/normal` })).body.toString(), 'decoded content');
        await assert.rejects(transport.request({ url: `http://target.invalid/${encoding}/large` }), { code: 'RESPONSE_LIMIT' });
        await assert.rejects(transport.request({ url: `http://target.invalid/${encoding}/invalid` }), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(requests, 9, 'No rejected response is retried');
});

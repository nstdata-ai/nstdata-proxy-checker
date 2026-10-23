import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.NSTDATA_CHECKER_ROOT ? pathToFileURL(resolve(process.env.NSTDATA_CHECKER_ROOT) + '/') : new URL('../', import.meta.url);
const { checkProxy, checkProxies } = await import(new URL('src/index.js', root));
const targetURL = 'http://target.invalid/';
const ipProbeURL = 'http://echo.invalid/';
const echoIp = '203.0.113.7';
const details = (ip = echoIp) => ({ source: 'synthetic-lookup', information: { query: ip, country: 'Example',
    city: null, as: 'AS64500 Example', proxy: false, unknownField: 'must-not-leak' },
    retrievedAt: '2026-10-23T00:00:00.000Z', sourceUpdatedAt: null, cached: false });

async function gateway(t, handler) {
    const requests = [];
    const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('IP probes are explicit and keep the target and separate exit results distinct', async t => {
    const proxy = await gateway(t, (req, res) => res.end(req.url === targetURL ? '198.51.100.9' : JSON.stringify({ ip: echoIp })));
    const ordinary = await checkProxy(proxy.url, { targetURL });
    assert.equal(ordinary.ip, undefined); assert.equal(proxy.requests.length, 1);
    const result = await checkProxy(proxy.url, { targetURL, ipProbeURL });
    assert.equal(result.ok, true); assert.equal(result.observedIp, '198.51.100.9');
    assert.equal(result.ip.source, 'separate-probe'); assert.equal(result.ip.observedIp, echoIp);
    assert.equal(result.ip.probe.statusCode, 200); assert.equal(result.ip.lookup, undefined);
    assert.deepEqual(proxy.requests, [targetURL, targetURL, ipProbeURL]);
});

test('lookup receives the observed IP explicitly and keeps only bounded documented fields', async t => {
    const proxy = await gateway(t, (_req, res) => res.end(echoIp));
    let calls = 0;
    const result = await checkProxy(proxy.url, { targetURL, lookupIp: async (ip, options) => {
        calls++; assert.equal(ip, echoIp); assert.equal(options.timeoutMs, 20000);
        assert.ok(options.signal instanceof AbortSignal); return details(ip);
    } });
    assert.equal(result.ok, true); assert.equal(result.ip.source, 'target-response');
    assert.equal(result.ip.lookup.ok, true); assert.equal(result.ip.lookup.requested, true);
    assert.equal(result.ip.lookup.result.information.proxy, false);
    assert.equal(result.ip.lookup.result.information.city, null);
    assert.equal(result.ip.lookup.result.information.unknownField, undefined);
    assert.equal(calls, 1); assert.equal(proxy.requests.length, 1);
});

test('Nstdata client-IP envelopes are recognized only on API success', async t => {
    let envelope = { code: 200, err: false, data: { ip: echoIp } };
    const proxy = await gateway(t, (_req, res) => res.end(JSON.stringify(envelope)));
    const good = await checkProxy(proxy.url, { targetURL, lookupIp: async ip => details(ip) });
    assert.equal(good.observedIp, echoIp); assert.equal(good.ip.lookup.ok, true);
    for (const value of [{ code: 400, err: false, data: { ip: echoIp } },
        { code: 200, err: true, data: { ip: echoIp } }, { code: 200, err: false, data: { ip: 'nstdata.io' } }]) {
        envelope = value;
        const result = await checkProxy(proxy.url, { targetURL });
        assert.equal(result.observedIp, null);
    }
    assert.equal(proxy.requests.length, 4);
});

test('lookup failures and unavailable IPs do not overwrite the completed target check', async t => {
    let body = echoIp, status = 200, calls = 0;
    const proxy = await gateway(t, (_req, res) => { res.writeHead(status); res.end(body); });
    const lookupIp = async () => { calls++; throw Object.assign(new Error('private remote details'), { code: 'HTTP_ERROR', statusCode: 429 }); };
    const failedLookup = await checkProxy(proxy.url, { targetURL, lookupIp });
    assert.equal(failedLookup.ok, true); assert.equal(failedLookup.statusCode, 200);
    assert.equal(failedLookup.ip.lookup.error.code, 'HTTP_ERROR');
    assert.equal(failedLookup.ip.lookup.error.statusCode, 429);
    assert.doesNotMatch(JSON.stringify(failedLookup), /private remote details/);
    body = 'ordinary HTML';
    const missing = await checkProxy(proxy.url, { targetURL, lookupIp });
    assert.equal(missing.ip.lookup.requested, false); assert.equal(missing.ip.lookup.error.code, 'IP_NOT_OBSERVED');
    body = echoIp; status = 403;
    const denied = await checkProxy(proxy.url, { targetURL, lookupIp });
    assert.equal(denied.error.code, 'TARGET_HTTP_ERROR'); assert.equal(denied.ip.observedIp, null);
    assert.equal(calls, 1);
});

test('failed separate probes retain target success and never query an unobserved IP', async t => {
    const proxy = await gateway(t, (req, res) => { res.writeHead(req.url === targetURL ? 200 : 403); res.end(echoIp); });
    let calls = 0;
    const result = await checkProxy(proxy.url, { targetURL, ipProbeURL, lookupIp: async () => { calls++; return details(); } });
    assert.equal(result.ok, true); assert.equal(result.ip.observedIp, null);
    assert.equal(result.ip.probe.error.code, 'TARGET_HTTP_ERROR');
    assert.equal(result.ip.lookup.requested, false); assert.equal(calls, 0);
    assert.deepEqual(proxy.requests, [targetURL, ipProbeURL]);
});

test('diagnostic configuration validates the whole batch before any traffic', async t => {
    const proxy = await gateway(t, (_req, res) => res.end(echoIp));
    for (const options of [{ ipProbeURL: 'file:///private' }, { ipProbeURL: 'http://user:pass@echo.invalid/' }, { lookupIp: true }]) {
        await assert.rejects(checkProxies([proxy.url, proxy.url], { targetURL, ...options }), { code: 'INVALID_CONFIG' });
    }
    assert.equal(proxy.requests.length, 0);
});

test('lookup validation rejects mismatched IPs, malformed fields and reflected credentials', async t => {
    const proxy = await gateway(t, (_req, res) => res.end(echoIp));
    const url = new URL(proxy.url); url.username = 'private-user'; url.password = 'p"rivate-password';
    for (const value of [details('198.51.100.1'), { ...details(), information: { query: echoIp, country: 1 } },
        { ...details(), information: { query: echoIp, country: 'p"rivate-password' } },
        { ...details(), source: 'bad\nsource' }, { ...details(), information: { query: echoIp, city: 'x'.repeat(1025) } }]) {
        const result = await checkProxy(url.href, { targetURL, lookupIp: async () => value });
        assert.equal(result.ok, true); assert.equal(result.ip.lookup.error.code, 'IP_LOOKUP_FAILED');
        assert.doesNotMatch(JSON.stringify(result), /rivate-password|private-user|bad/);
    }
    const ipv6 = await gateway(t, (_req, res) => res.end('2001:db8::1'));
    const result = await checkProxy(ipv6.url, { targetURL, lookupIp: async () => details('2001:0db8:0:0:0:0:0:1') });
    assert.equal(result.ip.lookup.ok, true);
});

test('lookup deadlines and cancellation bound adapters without erasing the target result', async t => {
    const proxy = await gateway(t, (_req, res) => res.end(echoIp));
    const timed = await checkProxy(proxy.url, { targetURL, timeoutMs: 50, lookupIp: async () => new Promise(() => {}) });
    assert.equal(timed.ok, true); assert.equal(timed.ip.lookup.error.code, 'TIMEOUT');
    const controller = new AbortController();
    const cancelled = await checkProxy(proxy.url, { targetURL, signal: controller.signal, lookupIp: async () => {
        controller.abort(); return new Promise(() => {});
    } });
    assert.equal(cancelled.ok, true); assert.equal(cancelled.ip.lookup.error.code, 'CANCELLED');
    const stopped = await checkProxy(proxy.url, { targetURL, ipProbeURL, signal: controller.signal });
    assert.equal(stopped.error.code, 'CANCELLED'); assert.equal(stopped.ip.probe.probeRequested, false);
    assert.equal(proxy.requests.length, 2);
});

test('diagnostic batches retain ordering and bounded per-entry requests', async t => {
    const proxy = await gateway(t, (req, res) => res.end(req.url === targetURL ? 'page' : echoIp));
    let calls = 0;
    const result = await checkProxies([proxy.url, 'invalid', proxy.url], { targetURL, ipProbeURL,
        invalidInput: 'report', concurrency: 2, lookupIp: async ip => { calls++; return details(ip); } });
    assert.deepEqual(result.results.map(row => row.index), [0, 1, 2]);
    assert.equal(result.succeeded, 2); assert.equal(result.failed, 1);
    assert.equal(proxy.requests.length, 4); assert.equal(calls, 2);
    assert.equal(result.results[1].ip, undefined);
});

async function cli(args, env) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('src/cli.js', root)), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
}

test('CLI exit probes work without the optional lookup package, including CSV', async t => {
    const proxy = await gateway(t, (req, res) => res.end(req.url === targetURL ? 'page' : echoIp));
    for (const format of ['json', 'csv']) {
        const result = await cli(['--target', targetURL, '--ip-probe', ipProbeURL, '--format', format], { NSTDATA_PROXY_URL: proxy.url });
        assert.equal(result.code, 0); assert.equal(result.stderr, '');
        if (format === 'json') assert.equal(JSON.parse(result.stdout).results[0].ip.observedIp, echoIp);
        else { assert.match(result.stdout, /ipSource,exitIp,ipProbeErrorCode,ipLookupErrorCode/); assert.match(result.stdout, /separate-probe,203\.0\.113\.7/); }
    }
    const missing = await cli(['--target', targetURL, '--ip-info'], { NSTDATA_PROXY_URL: proxy.url });
    assert.equal(missing.code, 2); assert.equal(JSON.parse(missing.stderr).error.code, 'IP_LOOKUP_NOT_INSTALLED');
    assert.equal(proxy.requests.length, 4);
});

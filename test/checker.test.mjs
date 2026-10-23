import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.env.NSTDATA_CHECKER_ROOT ? pathToFileURL(resolve(process.env.NSTDATA_CHECKER_ROOT) + '/') : new URL('../', import.meta.url);
const { checkProxy, checkProxies } = await import(new URL('src/index.js', root));

async function gateway(t, handler = (_req, res) => res.end('{"ip":"203.0.113.7"}')) {
    let active = 0, maxActive = 0;
    const rows = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        rows.push({ url: req.url, auth: req.headers['proxy-authorization'] });
        active++; maxActive = Math.max(active, maxActive);
        res.once('close', () => active--);
        handler(req, res);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('connect', (req, socket) => { rows.push({ url: req.url }); socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); for (const s of sockets) s.destroy(); await closed; });
    return { url: `http://127.0.0.1:${server.address().port}`, rows, maxActive: () => maxActive, sockets };
}
const targetURL = 'http://authorized.invalid/check';

test('HTTP check preserves status/probe latency/observed IP and keeps Basic auth at gateway', async t => {
    const proxy = await gateway(t);
    const url = new URL(proxy.url); url.username = 'user'; url.password = 'p%3Ass';
    const result = await checkProxy(url.toString(), { targetURL });
    assert.equal(result.ok, true); assert.equal(result.statusCode, 200);
    assert.equal(result.observedIp, '203.0.113.7'); assert.ok(result.elapsedMs >= 0);
    assert.equal(proxy.rows[0].url, targetURL);
    assert.equal(proxy.rows[0].auth, `Basic ${Buffer.from('user:p:ss').toString('base64')}`);
    assert.doesNotMatch(JSON.stringify(result), /user|p%3Ass|Basic/);
});

test('non-IP body remains unknown, target failure remains distinct from gateway auth', async t => {
    const proxy = await gateway(t, (_req, res) => { res.writeHead(403); res.end('not an IP'); });
    const result = await checkProxy(proxy.url, { targetURL });
    assert.equal(result.ok, false); assert.equal(result.statusCode, 403);
    assert.equal(result.observedIp, null); assert.equal(result.error.code, 'TARGET_HTTP_ERROR');
});

test('redirect targets are never followed or retried and their details stay out of output', async t => {
    const destination = await gateway(t);
    let status, location;
    const proxy = await gateway(t, (_req, res) => {
        res.writeHead(status, { Location: location }); res.end('sensitive-redirect-body');
    });
    for (const code of [301, 302, 303, 307, 308]) for (const crossOrigin of [false, true]) for (const expectedText of [undefined, 'sensitive-redirect-body']) {
        status = code; location = (crossOrigin ? destination.url : 'http://authorized.invalid') + '/sensitive-destination';
        const before = proxy.rows.length;
        const result = await checkProxy(proxy.url, { targetURL, expectedText });
        assert.equal(result.ok, false); assert.equal(result.probeRequested, true);
        assert.equal(result.statusCode, code); assert.ok(result.elapsedMs >= 0);
        assert.equal(result.error.code, 'TARGET_HTTP_ERROR'); assert.equal(result.observedIp, null);
        assert.equal(proxy.rows.length - before, 1); assert.equal(proxy.rows.at(-1).url, targetURL);
        assert.doesNotMatch(JSON.stringify(result), /sensitive-redirect-body|sensitive-destination/);
    }
    assert.equal(destination.rows.length, 0);
});

test('HTTPS CONNECT 407 is authorization failure with no invented status/timing', async t => {
    const proxy = await gateway(t);
    const result = await checkProxy(proxy.url, { targetURL: 'https://authorized.invalid/' });
    assert.equal(result.error.code, 'PROXY_AUTHORIZATION_FAILED');
    assert.equal(result.elapsedMs, null); assert.equal(result.statusCode, null);
    assert.equal(proxy.rows.length, 1);
});

test('deadline and response-byte cap stop a probe without retry', async t => {
    const slow = await gateway(t, (_req, res) => { res.writeHead(200); res.write('pending'); });
    const originalRequest = http.request, attempts = [];
    t.mock.method(http, 'request', function (...args) {
        const request = Reflect.apply(originalRequest, this, args);
        attempts.push({ request, closed: new Promise(resolve => request.once('close', resolve)) });
        return request;
    });
    const result = await checkProxy(slow.url, { targetURL, timeoutMs: 50 });
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal(attempts.length, 1);
    await attempts[0].closed;
    assert.equal(attempts[0].request.destroyed, true);
    const big = await gateway(t, (_req, res) => res.end('x'.repeat(1000)));
    assert.equal((await checkProxy(big.url, { targetURL, maxResponseBytes: 256 })).error.code, 'RESPONSE_LIMIT');
    assert.equal(big.rows.length, 1);
});

test('bad configuration validates whole batch before any request', async t => {
    const proxy = await gateway(t);
    for (const proxies of [[proxy.url, 'socks5://unsupported:1'], [], new Array(101).fill(proxy.url)]) {
        await assert.rejects(checkProxies(proxies, { targetURL }), { code: 'INVALID_CONFIG' });
    }
    assert.equal(proxy.rows.length, 0);
    const invalidCa = await checkProxy(proxy.url, { targetURL, caFile: '/nonexistent-fixture-ca.pem' });
    assert.equal(invalidCa.error.code, 'INVALID_CONFIG'); assert.equal(invalidCa.probeRequested, false);
});

test('batch preserves order, duplicates, partial failures and concurrency bound', async t => {
    const good = await gateway(t, (_req, res) => setTimeout(() => res.end('203.0.113.7'), 30));
    const bad = await gateway(t, (_req, res) => { res.writeHead(500); res.end(); });
    const result = await checkProxies([good.url, bad.url, good.url], { targetURL, concurrency: 2 });
    assert.deepEqual(result.results.map(r => r.index), [0, 1, 2]);
    assert.deepEqual(result.results.map(r => r.ok), [true, false, true]);
    assert.equal(result.succeeded, 2); assert.equal(result.failed, 1);
    assert.ok(good.maxActive() <= 2); assert.equal(good.rows.length, 2);
});

test('caller cancellation halts active call and leaves queued probes unrequested', async t => {
    let receiving;
    const started = new Promise(resolve => { receiving = resolve; });
    const proxy = await gateway(t, (_req, res) => { res.writeHead(200); res.write('pending'); receiving(); });
    const controller = new AbortController();
    const pending = checkProxies([proxy.url, proxy.url], { targetURL, concurrency: 1, signal: controller.signal });
    await started;
    controller.abort();
    const result = await pending;
    assert.equal(result.results[0].error.code, 'CANCELLED');
    assert.equal(result.results[0].probeRequested, true);
    assert.equal(result.results[1].probeRequested, false);
    assert.equal(proxy.rows.length, 1);
});

async function cli(args, env = {}) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('src/cli.js', root)), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
}

test('CLI help/missing inputs do not need a Crawl key or server process', async () => {
    assert.equal((await cli(['--help'])).code, 0);
    const invalid = await cli([]); assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_CONFIG');
});

test('CLI protected batch file produces no credentials in either stream', async t => {
    const proxy = await gateway(t);
    const temp = await mkdtemp(join(tmpdir(), 'nstdata-checker-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const file = join(temp, 'input.json');
    const url = new URL(proxy.url); url.username = 'sensitive-user'; url.password = 'sensitive-password';
    await writeFile(file, JSON.stringify([url.toString()]), { mode: 0o600 });
    const result = await cli(['--file', file, '--target', targetURL]);
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).succeeded, 1);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-user|sensitive-password|Basic/);
});

test('content assertion uses one GET, preserves default behavior and suppresses body/expectation', async t => {
    const proxy = await gateway(t, (_req, res) => res.end('prefix 秘密, "marker" suffix'));
    const expectedText = '秘密, "marker"';
    const passed = await checkProxy(proxy.url, { targetURL, expectedText });
    assert.equal(passed.ok, true); assert.equal(passed.contentMatched, true); assert.equal(passed.observedIp, null);
    assert.equal(passed.statusCode, 200); assert.ok(passed.elapsedMs >= 0);
    const failed = await checkProxy(proxy.url, { targetURL, expectedText: 'MISSING-MARKER' });
    assert.equal(failed.ok, false); assert.equal(failed.contentMatched, false); assert.equal(failed.error.code, 'CONTENT_MISMATCH');
    const ordinary = await checkProxy(proxy.url, { targetURL });
    assert.equal(ordinary.ok, true); assert.equal(Object.hasOwn(ordinary, 'contentMatched'), false);
    assert.equal(proxy.rows.length, 3); assert.ok(proxy.rows.every(row => row.url === targetURL));
    assert.doesNotMatch(JSON.stringify([passed, failed]), /marker|秘密|MISSING-MARKER|suffix/);
    const ip = await gateway(t);
    assert.equal((await checkProxy(ip.url, { targetURL, expectedText: '203.0.113.7' })).observedIp, '203.0.113.7');
});

test('assertion keeps HTTP errors distinct and fails bounded or cancelled reads without inventing a match', async t => {
    const bad = await gateway(t, (_req, res) => { res.writeHead(403); res.end('marker'); });
    const result = await checkProxy(bad.url, { targetURL, expectedText: 'marker' });
    assert.equal(result.contentMatched, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'TARGET_HTTP_ERROR');
    const large = await gateway(t, (_req, res) => res.end('x'.repeat(300)));
    const limited = await checkProxy(large.url, { targetURL, expectedText: 'x', maxResponseBytes: 256 });
    assert.equal(limited.error.code, 'RESPONSE_LIMIT'); assert.equal(limited.contentMatched, null);
    const cancelled = new AbortController(); cancelled.abort();
    const stopped = await checkProxy(large.url, { targetURL, expectedText: 'x', signal: cancelled.signal });
    assert.equal(stopped.contentMatched, null); assert.equal(stopped.probeRequested, false); assert.equal(large.rows.length, 1);
    let receiving;
    const started = new Promise(resolve => { receiving = resolve; });
    const slow = await gateway(t, (_req, res) => { res.writeHead(200); res.write('pending'); receiving(); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = checkProxy(slow.url, { targetURL, expectedText: 'pending', timeoutMs: 50 });
    await started;
    t.mock.timers.tick(50);
    const timed = await pending;
    t.mock.timers.reset();
    assert.equal(timed.error.code, 'TIMEOUT'); assert.equal(timed.contentMatched, null); assert.equal(slow.rows.length, 1);
    const oversized = await gateway(t, (_req, res) => res.end('x'.repeat(17000)));
    const outputLimited = await checkProxy(oversized.url, { targetURL, expectedText: 'x' });
    assert.equal(outputLimited.error.code, 'OUTPUT_LIMIT'); assert.equal(outputLimited.contentMatched, null);
});

test('redacted or literal redaction-marker bodies never become false content passes', async t => {
    const proxy = await gateway(t, (_req, res) => res.end('marker sensitive-password'));
    const url = new URL(proxy.url); url.username = 'sensitive-user'; url.password = 'sensitive-password';
    for (const expectedText of ['marker', '<REDACTED>', 'sensitive-password']) {
        const result = await checkProxy(url.toString(), { targetURL, expectedText });
        assert.equal(result.ok, false); assert.equal(result.contentMatched, null); assert.equal(result.error.code, 'CONTENT_UNAVAILABLE');
        assert.equal(result.statusCode, 200); assert.ok(result.elapsedMs >= 0);
        assert.doesNotMatch(JSON.stringify(result), /sensitive-user|sensitive-password|REDACTED|marker/);
    }
    const literal = await gateway(t, (_req, res) => res.end('<REDACTED>'));
    assert.equal((await checkProxy(literal.url, { targetURL, expectedText: '<REDACTED>' })).error.code, 'CONTENT_UNAVAILABLE');
    assert.equal(proxy.rows.length, 3); assert.equal(literal.rows.length, 1);
});

test('batch preflight snapshots inputs before asynchronous probing', async t => {
    const proxy = await gateway(t);
    const entries = [proxy.url, proxy.url];
    const pending = checkProxies(entries, { targetURL, invalidInput: 'report' });
    entries[1] = 'socks5://mutated.invalid:1'; entries.push(null);
    const result = await pending; assert.equal(result.total, 2); assert.equal(result.succeeded, 2); assert.equal(proxy.rows.length, 2);
});

test('per-entry reporting preserves order/duplicates and never probes invalid inputs', async t => {
    const proxy = await gateway(t);
    const proxies = [proxy.url, 'socks5://sensitive-user:sensitive-password@invalid:1', null, proxy.url, 42, '', {}];
    const result = await checkProxies(proxies, { targetURL, invalidInput: 'report', concurrency: 2 });
    assert.equal(result.total, 7); assert.equal(result.succeeded, 2); assert.equal(result.failed, 5);
    assert.deepEqual(result.results.map(r => r.index), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(proxy.rows.length, 2);
    for (const i of [1, 2, 4, 5, 6]) {
        assert.equal(result.results[i].error.code, 'INVALID_CONFIG'); assert.equal(result.results[i].probeRequested, false);
        assert.equal(result.results[i].statusCode, null); assert.equal(result.results[i].elapsedMs, null);
    }
    assert.doesNotMatch(JSON.stringify(result), /sensitive-user|sensitive-password|socks5|invalid:1/);
    const sparse = await checkProxies(new Array(2), { targetURL, invalidInput: 'report' });
    assert.equal(sparse.failed, 2); assert.ok(sparse.results.every(r => r.error.code === 'INVALID_CONFIG'));
    await assert.rejects(checkProxies(proxies, { targetURL }), { code: 'INVALID_CONFIG' }); assert.equal(proxy.rows.length, 2);
});

test('report mode validates common options before HTTP and distinguishes invalid from cancelled rows', async t => {
    const proxy = await gateway(t);
    for (const change of [{ expectedText: '' }, { expectedText: 1 }, { expectedText: '密'.repeat(1366) }, { targetURL: 'not-url' }, { timeoutMs: 0 }, { invalidInput: 'ignore' }, { signal: {} }])
        await assert.rejects(checkProxies([proxy.url, null], { targetURL, invalidInput: 'report', ...change }), { code: 'INVALID_CONFIG' });
    const controller = new AbortController(); controller.abort();
    const result = await checkProxies([null, proxy.url], { targetURL, invalidInput: 'report', expectedText: 'marker', signal: controller.signal });
    assert.equal(result.results[0].error.code, 'INVALID_CONFIG'); assert.equal(result.results[1].error.code, 'CANCELLED');
    assert.ok(result.results.every(r => r.probeRequested === false && r.contentMatched === null)); assert.equal(proxy.rows.length, 0);
});

test('CLI file mode reports each invalid entry; CSV has fixed safe columns and content failures exit one', async t => {
    const proxy = await gateway(t);
    const temp = await mkdtemp(join(tmpdir(), 'nstdata-checker-csv-')); t.after(() => rm(temp, { recursive: true, force: true }));
    const file = join(temp, 'input.json'), url = new URL(proxy.url); url.username = 'sensitive-user'; url.password = 'sensitive-password';
    await writeFile(file, JSON.stringify([url.toString(), '=UNSAFE-CELL', null]), { mode: 0o600 });
    const json = await cli(['--file', file, '--target', targetURL]);
    assert.equal(json.code, 1); assert.equal(JSON.parse(json.stdout).failed, 2); assert.equal(json.stderr, '');
    const csv = await cli(['--file', file, '--target', targetURL, '--format', 'csv', '--expected-text', '203.0.113.7']);
    assert.equal(csv.code, 1); assert.equal(csv.stderr, '');
    const rows = csv.stdout.trimEnd().split('\r\n').map(row => row.split(','));
    assert.deepEqual(rows[0], ['index', 'ok', 'protocol', 'probeRequested', 'statusCode', 'elapsedMs', 'observedIp', 'contentMatched', 'errorCode']);
    assert.deepEqual(rows[1].slice(0, 5), ['0', 'true', 'http', 'true', '200']); assert.ok(Number(rows[1][5]) >= 0);
    assert.deepEqual(rows[1].slice(6), ['203.0.113.7', 'true', '']);
    assert.deepEqual(rows[2], ['1', 'false', '', 'false', '', '', '', '', 'INVALID_CONFIG']);
    assert.deepEqual(rows[3], ['2', 'false', '', 'false', '', '', '', '', 'INVALID_CONFIG']);
    assert.doesNotMatch(json.stdout + csv.stdout + csv.stderr, /sensitive-user|sensitive-password|Basic|UNSAFE-CELL/);
    const mismatch = await cli(['--target', targetURL, '--expected-text', 'missing'], { NSTDATA_PROXY_URL: url.toString() });
    assert.equal(mismatch.code, 1); assert.equal(JSON.parse(mismatch.stdout).results[0].error.code, 'CONTENT_MISMATCH');
    assert.equal((await cli(['--file', file, '--target', targetURL, '--format', 'invalid'])).code, 2);
    assert.equal(proxy.rows.length, 3);
});

test('content assertions reject malformed UTF-8 without scoring replacement characters', async t => {
    let bytes = Buffer.from([0x80, 0xff, ...Buffer.from(' marker')]), statusCode = 200;
    const proxy = await gateway(t, (_req, res) => { res.writeHead(statusCode); res.end(bytes); });
    const ordinary = await checkProxy(proxy.url, { targetURL });
    assert.equal(ordinary.ok, true);
    assert.equal(Object.hasOwn(ordinary, 'contentMatched'), false);
    for (const expectedText of ['�', 'marker']) {
        const before = proxy.rows.length;
        const result = await checkProxy(proxy.url, { targetURL, expectedText });
        assert.equal(result.ok, false);
        assert.equal(result.statusCode, 200);
        assert.ok(result.elapsedMs >= 0);
        assert.equal(result.contentMatched, null);
        assert.equal(result.error.code, 'CONTENT_UNAVAILABLE');
        assert.equal(proxy.rows.length - before, 1);
    }
    const result = await cli(['--target', targetURL, '--expected-text', '�'], { NSTDATA_PROXY_URL: proxy.url });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).results[0].error.code, 'CONTENT_UNAVAILABLE');
    assert.doesNotMatch(result.stdout + result.stderr, /marker|�/);
    statusCode = 403;
    const failed = await checkProxy(proxy.url, { targetURL, expectedText: 'marker' });
    assert.equal(failed.error.code, 'TARGET_HTTP_ERROR');
    assert.equal(failed.contentMatched, null);
    statusCode = 200; bytes = Buffer.from('� marker');
    const valid = await checkProxy(proxy.url, { targetURL, expectedText: '�' });
    assert.equal(valid.ok, true);
    assert.equal(valid.contentMatched, true);
    assert.equal(proxy.rows.length, 6);
});


test('assertion output limits preserve completed HTTP status and measured timing', async t => {
    for (const statusCode of [200, 403]) {
        const proxy = await gateway(t, (_req, res) => { res.writeHead(statusCode); res.end('x'.repeat(17000)); });
        const result = await checkProxy(proxy.url, { targetURL, expectedText: 'x' });
        assert.equal(result.ok, false);
        assert.equal(result.statusCode, statusCode);
        assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
        assert.equal(result.contentMatched, null);
        assert.equal(result.error.code, statusCode === 200 ? 'OUTPUT_LIMIT' : 'TARGET_HTTP_ERROR');
        assert.equal(proxy.rows.length, 1);
        assert.doesNotMatch(JSON.stringify(result), /x{20}/);
    }
});

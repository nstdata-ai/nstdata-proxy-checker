import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nstdataFixture, apiKey } from './nstdata-fixture.mjs';
import { listen, tlsMaterial } from './proxy-fixtures.mjs';

const root = process.env.NSTDATA_CHECKER_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const guards = await mkdtemp(join(tmpdir(), 'nstdata-checker-network-'));
const guard = join(guards, 'loopback.cjs');
await writeFile(guard, `const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === 'object' ? options.host : args[1];
    if (host !== '127.0.0.1') throw new Error('Nstdata CLI tests allow loopback only');
    return Reflect.apply(connect, this, args);
};\n`);
after(() => rm(guards, { recursive: true, force: true }));
const isolated = env => ({ ...env, NODE_OPTIONS: '--require=' + JSON.stringify(guard) });
async function cli(args, env = {}) {
    try {
        const result = await promisify(execFile)(process.execPath, [resolve(root, 'src/cli.js'), ...args], { env: isolated(env), timeout: 10000 });
        return { ...result, code: 0 };
    } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}
const target = ['--target', 'http://fixture.invalid/'];

test('Nstdata CLI obtains one HTTP proxy and checks it once without exposing credentials', async t => {
    const { state, env } = await nstdataFixture(t);
    const result = await cli(['--nstdata', '--yes', ...target], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].statusCode, 200);
    assert.equal(state.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(state.requests.filter(row => row.path.endsWith('/proxies')).length, 1);
    assert.equal(state.requests.at(-1).query.protocol, 'http');
    assert.equal(state.requests.at(-1).query.count, '1');
    assert.deepEqual(state.probes, ['http://fixture.invalid/']);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${apiKey}|fixture-user|fixture-password|fixture-channel|Example Domain`));
});

test('Nstdata mode defaults to an HTTPS target and verifies the complete CONNECT/TLS flow', async t => {
    const tls = tlsMaterial(t, { san: 'DNS:example.com', commonName: 'example.com' });
    const targets = [];
    const destination = https.createServer(tls, (req, res) => { targets.push(req.headers.host); res.end('Example Domain'); });
    const port = await listen(t, destination);
    const { state, env } = await nstdataFixture(t, { connect(_req, socket, head) {
        const upstream = net.connect(port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(socket); socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
    } });
    const result = await cli(['--nstdata', '--yes'], { ...env, NSTDATA_PROXY_CA_FILE: tls.certFile });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].statusCode, 200);
    assert.deepEqual(state.probes, ['example.com:443']);
    assert.deepEqual(targets, ['example.com']);
});

test('interrupting channel creation stops local waiting without generation, deletion or another attempt', async t => {
    let creating;
    const submitted = new Promise(resolve => { creating = resolve; });
    const { state, env } = await nstdataFixture(t, { handle(_req, _res, url) {
        if (url.pathname.endsWith('/channel')) { creating(); return true; }
    } });
    const child = spawn(process.execPath, [resolve(root, 'src/cli.js'), '--nstdata', '--yes', ...target], { env: isolated(env) });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const closed = once(child, 'close');
    await Promise.race([submitted, new Promise((_, reject) => setTimeout(() => reject(new Error('Creation was not reached')), 5000).unref())]);
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 130, stderr);
    assert.equal(JSON.parse(stderr).error.code, 'ABORTED');
    assert.equal(stdout, ''); assert.equal(state.probes.length, 0);
    assert.equal(state.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(state.requests.filter(row => row.path.endsWith('/proxies') || row.method === 'DELETE').length, 0);
});

test('Nstdata CLI reuses the default across processes and respects a required country', async t => {
    const { state, env } = await nstdataFixture(t);
    for (let i = 0; i < 2; i++) {
        const result = await cli(['--nstdata', '--yes', '--country', 'GB', ...target], env);
        assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(state.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(state.requests.filter(row => row.path.endsWith('/proxies')).length, 2);
    assert.ok(state.requests.filter(row => row.path.endsWith('/proxies')).every(row => row.query.country === 'GB'));
    assert.equal(state.probes.length, 2);
});

test('Nstdata CLI validates flags, target, credentials and confirmation before any API call', async t => {
    const { state, env } = await nstdataFixture(t);
    const cases = [
        { args: ['--nstdata', '--yes', '--file', 'proxies.json'], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', '--yes', '--target', 'not-a-url'], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', '--yes', ...target, '--timeout', '0'], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', '--yes', ...target, '--format', 'text'], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', ...target], code: 'CONFIRMATION_REQUIRED' },
        { args: ['--nstdata', '--yes', ...target], env: {}, code: 'MISSING_API_KEY' },
        { args: ['--yes', ...target], code: 'INVALID_CONFIG' },
        { args: ['--country', 'GB', ...target], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', '--yes', '--env', '', ...target], code: 'INVALID_CONFIG' },
        { args: ['--nstdata', '--yes', ...target], env: { ...env, NSTDATA_PROXY_CA_FILE: '/missing-fixture-ca.pem' }, code: 'INVALID_CONFIG' },
    ];
    for (const entry of cases) {
        const result = await cli(entry.args, entry.env ?? env);
        assert.equal(result.code, 2, result.stderr);
        assert.equal(JSON.parse(result.stderr).error.code, entry.code);
        assert.equal(result.stdout, '');
        assert.doesNotMatch(result.stderr, new RegExp(apiKey));
    }
    assert.equal(state.requests.length, 0); assert.equal(state.probes.length, 0);
});

test('having an API key never enables account operations without the explicit mode', async t => {
    const { state, env, proxyURL } = await nstdataFixture(t);
    const result = await cli(target, { ...env, NSTDATA_PROXY_URL: proxyURL });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state.requests.length, 0); assert.equal(state.probes.length, 1);
});

test('Nstdata CLI loads only an explicit env file and allows JSON/CSV target failure reporting', async t => {
    const { state, env } = await nstdataFixture(t, { status: 503 });
    const dir = await mkdtemp(join(tmpdir(), 'nstdata-checker-env-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, '.env');
    await writeFile(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
    for (const format of ['json', 'csv']) {
        const result = await cli(['--nstdata', '--yes', '--env', file, ...target, '--format', format]);
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stdout, /503/); assert.match(result.stdout, /TARGET_HTTP_ERROR/);
        assert.equal(result.stderr, '');
    }
    assert.equal(state.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(state.requests.filter(row => row.path.endsWith('/proxies')).length, 2);
    assert.equal(state.probes.length, 2);
});

test('setup failure or an uncertain creation never continues to generation or a target probe', async t => {
    for (const mode of ['balance', 'unknown', 'unavailable']) {
        const { state, env } = await nstdataFixture(t, { balance: mode === 'balance' ? 0 : 20,
            handle(req, res, url) {
                if (!url.pathname.endsWith('/channel')) return;
                if (mode === 'unknown') { req.socket.destroy(); return true; }
                if (mode === 'unavailable') { res.writeHead(503); res.end(apiKey); return true; }
            } });
        const result = await cli(['--nstdata', '--yes', ...target], env);
        assert.equal(result.code, 1, result.stderr);
        assert.equal(JSON.parse(result.stderr).error.code, mode === 'balance' ? 'INSUFFICIENT_BALANCE' : 'CHANNEL_CREATION_UNCERTAIN');
        if (mode === 'unavailable') {
            const error = JSON.parse(result.stderr).error;
            assert.equal(error.statusCode, 503);
            assert.equal(error.hint, undefined);
            assert.match(error.message, /Check existing channels/);
        }
        assert.equal(state.requests.filter(row => row.method === 'POST').length, mode === 'balance' ? 0 : 1);
        assert.equal(state.requests.filter(row => row.path.endsWith('/proxies')).length, 0);
        assert.equal(state.probes.length, 0);
    }
});

test('Nstdata CLI preserves safe API diagnostics without generation, traffic or retry', async t => {
    for (const scenario of [
        { status: 401, hint: /NSTDATA_API_TOKEN/ },
        { status: 403, hint: /permissions/ },
        { status: 429, hint: /rate limit/ },
        { status: 503, hint: /service/ },
        { status: 200, applicationCode: 403, expectedApplicationCode: 403, hint: /permissions/ },
        { status: 201, applicationCode: 403, expectedApplicationCode: 403, hint: /permissions/ },
        { status: 200, applicationCode: 10001, expectedApplicationCode: 10001 },
        { status: 200, applicationCode: 1.5 },
    ]) {
        const { state, env } = await nstdataFixture(t, { handle(_req, res) {
            res.writeHead(scenario.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ err: true, code: scenario.applicationCode ?? 403,
                message: `${apiKey} http://fixture-user:fixture-password@gateway.invalid/`, data: {} }));
            return true;
        } });
        const result = await cli(['--nstdata', '--yes', ...target], env);
        assert.equal(result.code, 1, result.stderr);
        assert.equal(result.stdout, '');
        const error = JSON.parse(result.stderr).error;
        assert.equal(error.code, scenario.status < 300 ? 'API_ERROR' : 'HTTP_ERROR');
        assert.equal(error.statusCode, scenario.status);
        assert.equal(error.applicationCode, scenario.expectedApplicationCode);
        if (scenario.hint) assert.match(error.hint, scenario.hint);
        else assert.equal(error.hint, undefined);
        assert.doesNotMatch(result.stderr, /checker-synthetic-api-key|fixture-user|fixture-password|gateway\.invalid/);
        assert.equal(state.requests.length, 1);
        assert.ok(state.requests.every(row => row.method === 'GET' && row.path.endsWith('/user/info')));
        assert.equal(state.probes.length, 0);
    }
});

test('an unsupported generated proxy stops before traffic instead of falling back', async t => {
    const { state, env } = await nstdataFixture(t, { generatedURL: 'socks5://fixture:secret@127.0.0.1:1' });
    const result = await cli(['--nstdata', '--yes', ...target], env);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'PROXY_GENERATION_UNCERTAIN');
    assert.equal(state.requests.filter(row => row.path.endsWith('/proxies')).length, 1);
    assert.equal(state.probes.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /secret|socks5|127\.0\.0\.1/);
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { shellCommands } from './documentation.mjs';

const execute = promisify(execFile);

export async function checkDocumentedCommands({ root, temp, archive, manifest, files, environment }) {
    const requests = [];
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
    const registry = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        requests.push({ method: req.method, pathname, authorization: Boolean(req.headers.authorization) });
        if (req.method !== 'GET' || req.headers.authorization) { res.writeHead(403); res.end(); return; }
        if (pathname === '/' + manifest.name) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version },
                versions: { [manifest.version]: { ...manifest, dist: { integrity,
                    tarball: `http://127.0.0.1:${registry.address().port}/checker.tgz` } } } }));
        } else if (pathname === '/checker.tgz') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(readFileSync(archive)); }
        else { res.writeHead(404); res.end(); }
    });
    let status = 200;
    const probes = [];
    const gateway = http.createServer((req, res) => {
        probes.push(req.url);
        assert.equal(req.method, 'GET');
        assert.ok(['http://fixture.invalid/', 'http://fixture.invalid/ip'].includes(req.url));
        res.writeHead(req.url.endsWith('/ip') ? 200 : status);
        res.end(req.url.endsWith('/ip') ? '203.0.113.7' : 'Example Domain');
    });
    registry.listen(0, '127.0.0.1'); gateway.listen(0, '127.0.0.1');
    try {
        await Promise.all([once(registry, 'listening'), once(gateway, 'listening')]);
        const env = { ...environment, npm_config_offline: 'false',
            npm_config_registry: `http://127.0.0.1:${registry.address().port}`,
            NSTDATA_PROXY_URL: `http://doc-user:doc-password@127.0.0.1:${gateway.address().port}` };
        await execute(process.execPath, ['-e', "require('node:assert/strict').throws(() => require('node:net').connect({host:'198.51.100.1',port:80}),{code:'DOCS_NETWORK_BLOCKED'})"], { env, timeout: 10000 });
        let cliCases = 0;
        for (const language of ['en', 'zh']) {
            const application = join(temp, 'application-' + language); mkdirSync(application);
            writeFileSync(join(application, 'package.json'), '{"private":true,"type":"module"}');
            const localEnv = { ...env, npm_config_cache: join(application, 'cache') };
            const proxies = join(application, 'proxies.json');
            writeFileSync(proxies, JSON.stringify([env.NSTDATA_PROXY_URL, env.NSTDATA_PROXY_URL]), { mode: 0o600 });
            const readme = language === 'en' ? 'README.md' : 'README_zh.md';
            const guide = language === 'en' ? 'docs/guide.md' : 'docs/guide_zh.md';
            const commands = [readme, guide].flatMap(file => shellCommands(readFileSync(join(root, file), 'utf8')));
            for (const command of commands) {
                // Paired Node.js examples run through their documented commands in the package check.
                if (command[0] === 'node') continue;
                if (command[0] === 'npm') {
                    assert.deepEqual(command.slice(0, 2), ['npm', 'install']);
                    assert.equal(command.length, 3);
                    assert.equal(command[2], manifest.name);
                    await execute(process.execPath, [process.env.npm_execpath, ...command.slice(1)], { cwd: application, env: localEnv, timeout: 30000 });
                    const installed = join(application, 'node_modules', command[2]);
                    const expected = manifest.version;
                    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, expected);
                    {
                        const lock = JSON.parse(readFileSync(join(application, 'node_modules/.package-lock.json'), 'utf8'));
                        assert.deepEqual(Object.keys(lock.packages), ['node_modules/' + manifest.name]);
                        const source = join(temp, 'node_modules', manifest.name);
                        for (const file of files) assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(source, file)));
                    }
                    continue;
                }
                assert.deepEqual(command.slice(0, 3), ['npx', '--no-install', 'nstdata-proxy-checker']);
                const args = command.slice(1).map(value => value === 'https://example.com/' ? 'http://fixture.invalid/'
                    : value === 'https://api.nstdata.io/api/v2/public/utility/client-ip' ? 'http://fixture.invalid/ip'
                    : value === '/path/to/proxies.json' ? proxies : value);
                for (status of [200, 503]) {
                    cliCases++;
                    const start = probes.length;
                    const beforeRegistry = requests.length;
                    let result, code = 0;
                    try { result = await execute(process.execPath, [join(dirname(process.env.npm_execpath), 'npx-cli.js'), ...args], { cwd: application, env: localEnv, timeout: 10000 }); }
                    catch (error) { result = error; code = error.code; }
                    assert.equal(code, status === 200 ? 0 : 1);
                    assert.equal(requests.length, beforeRegistry, 'npx --no-install must use the local package');
                    const rows = args.includes('--file') ? 2 : 1;
                    assert.equal(probes.length - start, rows * (args.includes('--ip-probe') ? 2 : 1));
                    assert.equal(result.stderr, '');
                    assert.doesNotMatch(result.stdout, /doc-user|doc-password|Example Domain/);
                    if (args.includes('csv')) {
                        assert.match(result.stdout, /^index,ok,protocol,probeRequested,statusCode,elapsedMs,/);
                        assert.equal(result.stdout.trim().split('\n').length, 3);
                        assert.ok(result.stdout.split('\n').slice(1, 3).every(line => line.includes(`,${status},`)));
                    } else {
                        const output = JSON.parse(result.stdout);
                        assert.equal(output.total, 1); assert.equal(output.results[0].statusCode, status);
                        assert.equal(output.results[0].ok, status === 200);
                        if (args.includes('--expected-text')) assert.equal(output.results[0].contentMatched, true);
                    }
                }
            }
        }
        assert.ok(requests.some(request => request.pathname === '/checker.tgz'));
        for (const request of requests) {
            assert.equal(request.method, 'GET'); assert.equal(request.authorization, false);
            // npm can query an absent optional peer; the fixture returns 404 and never installs it.
            assert.ok(['/' + manifest.name, '/checker.tgz', '/@nstdata-ai/ip-lookup'].includes(request.pathname), `Unexpected registry request: ${request.pathname}`);
        }
        return cliCases;
    } finally {
        await Promise.all([registry, gateway].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    }
}

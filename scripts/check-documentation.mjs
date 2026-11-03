import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { shellCommands } from './documentation.mjs';
import { packageRegistry } from './package-registry.mjs';
import { nstdataFixture, apiKey } from '../test/nstdata-fixture.mjs';

const execute = promisify(execFile);

export async function checkDocumentedCommands({ root, temp, archive, manifest, sdkPackage, files, environment }) {
    const standaloneDirectories = [];
    const registry = await packageRegistry([{ manifest, archive, filename: 'checker.tgz' }, sdkPackage]);
    const requests = registry.requests;
    const cleanup = [];
    const provider = await nstdataFixture({ after: fn => cleanup.push(fn) });
    let status = 200;
    const probes = [];
    const gateway = http.createServer((req, res) => {
        probes.push(req.url);
        assert.equal(req.method, 'GET');
        assert.ok(['http://fixture.invalid/', 'http://fixture.invalid/ip'].includes(req.url));
        res.writeHead(req.url.endsWith('/ip') ? 200 : status);
        res.end(req.url.endsWith('/ip') ? '203.0.113.7' : 'Example Domain');
    });
    gateway.listen(0, '127.0.0.1');
    try {
        await once(gateway, 'listening');
        const apiGuard = join(temp, 'document-api-origin.cjs');
        writeFileSync(apiGuard, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
    const url = new URL(input);
    return originalFetch(url.origin === 'https://api.nstdata.io'
        ? new URL(url.pathname + url.search, ${JSON.stringify(provider.env.NSTDATA_API_BASE_URL)}) : input, options);
};\n`);
        const env = { ...environment, npm_config_offline: 'false',
            npm_config_registry: registry.url,
            NODE_OPTIONS: environment.NODE_OPTIONS + ' --require=' + JSON.stringify(apiGuard),
            NSTDATA_PROXY_CHECK_URL: 'http://fixture.invalid/',
            NSTDATA_PROXY_URL: `http://doc-user:doc-password@127.0.0.1:${gateway.address().port}` };
        await execute(process.execPath, ['-e', "require('node:assert/strict').throws(() => require('node:net').connect({host:'198.51.100.1',port:80}),{code:'DOCS_NETWORK_BLOCKED'})"], { env, timeout: 10000 });
        let cliCases = 0;
        for (const language of ['en', 'zh']) {
            const application = join(temp, 'application-' + language); mkdirSync(application);
            writeFileSync(join(application, 'package.json'), '{"private":true,"type":"module"}');
            const cliDirectory = join(temp, 'cli-' + language); mkdirSync(cliDirectory);
            for (const folder of [application, cliDirectory]) writeFileSync(join(folder, '.env'),
                'NSTDATA_API_TOKEN=' + apiKey + '\n', { mode: 0o600 });
            const prefix = join(application, 'global');
            const localEnv = { ...env, npm_config_cache: join(application, 'cache'), npm_config_prefix: prefix,
                PATH: join(prefix, 'bin') + delimiter + env.PATH };
            let shellSetup;
            const proxies = join(application, 'proxies.json');
            writeFileSync(proxies, JSON.stringify([env.NSTDATA_PROXY_URL, env.NSTDATA_PROXY_URL]), { mode: 0o600 });
            const readme = language === 'en' ? 'README.md' : 'README_zh.md';
            const guide = language === 'en' ? 'docs/guide.md' : 'docs/guide_zh.md';
            const commands = [readme, guide].flatMap(file => shellCommands(readFileSync(join(root, file), 'utf8')));
            for (const command of commands) {
                // Paired Node.js examples run through their documented commands in the package check.
                if (command[0] === 'node') continue;
                if (command[0] === 'export') {
                    assert.deepEqual(command, ['export', 'NSTDATA_PROXY_URL=http://user:password@proxy.example:8080']);
                    shellSetup = `export NSTDATA_PROXY_URL='${env.NSTDATA_PROXY_URL}'`;
                    continue;
                }
                if (command[0] === 'npx' && command[1] === '--yes') {
                    assert.deepEqual(command, ['npx', '--yes', `--package=${manifest.name}`, 'nstdata-proxy-checker', '--help']);
                    // Keep npm's parent-directory discovery outside the installed-package test project.
                    const standalone = mkdtempSync(join(tmpdir(), 'nstdata-checker-npx-'));
                    standaloneDirectories.push(standalone);
                    const standaloneEnv = { ...localEnv, npm_config_cache: join(standalone, 'cache'),
                        npm_config_prefix: join(standalone, 'prefix'), PATH: environment.PATH };
                    delete standaloneEnv.NSTDATA_PROXY_URL;
                    const beforeRegistry = requests.length, beforeProbes = probes.length;
                    const result = await execute(process.execPath, [join(dirname(process.env.npm_execpath), 'npx-cli.js'), ...command.slice(1)],
                        { cwd: standalone, env: standaloneEnv, timeout: 30000 });
                    assert.match(result.stdout, /Usage: nstdata-proxy-checker/);
                    assert.equal(result.stderr, '');
                    assert.equal(probes.length, beforeProbes, 'Standalone help must not use proxy traffic');
                    assert.ok(requests.slice(beforeRegistry).some(request => request.pathname === '/checker.tgz'));
                    assert.equal(existsSync(join(standalone, 'node_modules')), false, 'Standalone use must not install into the project');
                    assert.equal(existsSync(join(standalone, 'package.json')), false, 'Standalone use must not require a project');
                    cliCases++;
                    continue;
                }
                if (command[0] === 'npm') {
                    assert.deepEqual(command.slice(0, 2), ['npm', 'install']);
                    const global = command[2] === '--global';
                    assert.deepEqual(command, global ? ['npm', 'install', '--global', manifest.name] : ['npm', 'install', manifest.name]);
                    await execute(process.execPath, [process.env.npm_execpath, ...command.slice(1)], { cwd: global ? cliDirectory : application, env: localEnv, timeout: 30000 });
                    if (global) {
                        assert.equal(existsSync(join(cliDirectory, 'package.json')), false);
                        assert.equal(existsSync(join(cliDirectory, 'node_modules')), false);
                    }
                    const installed = global ? join(prefix, 'lib/node_modules', manifest.name) : join(application, 'node_modules', manifest.name);
                    const expected = manifest.version;
                    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, expected);
                    {
                        if (!global) {
                            const lock = JSON.parse(readFileSync(join(application, 'node_modules/.package-lock.json'), 'utf8'));
                            assert.deepEqual(Object.keys(lock.packages).sort(), ['node_modules/@nstdata-ai/proxy', 'node_modules/' + manifest.name]);
                        }
                        const source = join(temp, 'node_modules', manifest.name);
                        for (const file of files) assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(source, file)));
                    }
                    continue;
                }
                const global = command[0] === 'nstdata-proxy-checker';
                const nstdata = command.includes('--nstdata');
                if (!global) assert.deepEqual(command.slice(0, 3), ['npx', '--no-install', 'nstdata-proxy-checker']);
                const args = command.slice(global ? 0 : 1).map(value => value === 'https://example.com/' ? 'http://fixture.invalid/'
                    : value === 'https://api.nstdata.io/api/v2/public/utility/client-ip' ? 'http://fixture.invalid/ip'
                    : value === '/path/to/proxies.json' ? proxies : value);
                for (status of [200, 503]) {
                    provider.state.status = status;
                    cliCases++;
                    const start = nstdata ? provider.state.probes.length : probes.length;
                    const generatedBefore = provider.state.requests.filter(row => row.path.endsWith('/proxies')).length;
                    const beforeRegistry = requests.length;
                    let result, code = 0;
                    try {
                        if (global) {
                            assert.ok(shellSetup, 'Quick start must configure the proxy before invoking the global CLI');
                            const runEnv = { ...localEnv }; delete runEnv.NSTDATA_PROXY_URL;
                            const script = shellSetup + '\n' + args.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
                            result = await execute('/bin/sh', ['-c', script], { cwd: cliDirectory, env: runEnv, timeout: 10000 });
                            assert.equal(existsSync(join(cliDirectory, 'package.json')), false);
                            assert.equal(existsSync(join(cliDirectory, 'node_modules')), false);
                        } else result = await execute(process.execPath, [join(dirname(process.env.npm_execpath), 'npx-cli.js'), ...args], { cwd: application, env: localEnv, timeout: 10000 });
                    }
                    catch (error) { result = error; code = error.code; }
                    assert.equal(code, status === 200 ? 0 : 1);
                    assert.equal(requests.length, beforeRegistry, 'npx --no-install must use the local package');
                    const rows = args.includes('--file') ? 2 : 1;
                    assert.equal((nstdata ? provider.state.probes.length : probes.length) - start, rows * (args.includes('--ip-probe') ? 2 : 1));
                    if (nstdata) assert.equal(provider.state.requests.filter(row => row.path.endsWith('/proxies')).length - generatedBefore, 1);
                    assert.equal(result.stderr, '');
                    assert.doesNotMatch(result.stdout, /doc-user|doc-password|Example Domain|checker-synthetic-api-key|fixture-password|fixture-channel/);
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
        assert.ok(requests.some(request => request.pathname === '/proxy.tgz'), 'Empty-cache installation must fetch the required SDK');
        for (const request of requests) {
            assert.equal(request.method, 'GET'); assert.equal(request.authorization, false);
            // npm can query an absent optional peer; the fixture returns 404 and never installs it.
            assert.ok(['/' + manifest.name, '/checker.tgz', '/@nstdata-ai/proxy', '/proxy.tgz', '/@nstdata-ai/ip-lookup'].includes(request.pathname), `Unexpected registry request: ${request.pathname}`);
        }
        return cliCases;
    } finally {
        await registry.close();
        await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); });
        for (const close of cleanup.reverse()) await close();
        for (const directory of standaloneDirectories) rmSync(directory, { recursive: true, force: true });
    }
}

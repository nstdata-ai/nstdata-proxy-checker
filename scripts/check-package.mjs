import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, basename } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'nstdata-checker-package-'));
assert.ok(process.env.npm_execpath, 'Run npm run check:package');
const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
try {
    const manifest = readJSON(join(root, 'package.json'));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    const lock = readJSON(join(root, 'package-lock.json'));
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
    assert.deepEqual(lock.packages[''].dependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies, { '@nstdata-ai/ip-lookup': '^1.0.0' });
    assert.deepEqual(manifest.peerDependenciesMeta, { '@nstdata-ai/ip-lookup': { optional: true } });
    assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
    assert.deepEqual(lock.packages[''].peerDependenciesMeta, manifest.peerDependenciesMeta);
    for (const [name, entry] of Object.entries(lock.packages)) if (name) {
        assert.equal(entry.dev, true, 'No runtime dependency is required');
        assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/') && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity));
    }
    assert.doesNotMatch(JSON.stringify(lock), /file:|_planning|\/Users\//);
    for (const file of ['README.md', 'README_zh.md']) {
        assert.ok(readFileSync(join(root, file), 'utf8').includes(`npm install ${manifest.name}@${manifest.version}`));
    }
    assert.ok(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## ${manifest.version} —`));
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root));
    assert.equal(pack.name, '@nstdata-ai/proxy-checker'); assert.equal(pack.version, manifest.version);
    const required = ['package.json', 'src/index.js', 'src/index.d.ts', 'src/cli.js', 'src/config.js', 'src/ip.js', 'src/transport.js', 'src/transport.d.ts',
        'README.md', 'README_zh.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/guide.md', 'docs/guide_zh.md'];
    assert.deepEqual(pack.files.map(x => x.path).sort(), required.sort());
    for (const file of pack.files) assert.doesNotMatch(readFileSync(join(root, file.path), 'utf8'),
        /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bnpm_[a-zA-Z0-9]{30,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\/Users\/|_planning\//);
    for (const { path: file } of pack.files.filter(file => file.path.endsWith('.md'))) {
        const text = readFileSync(join(root, file), 'utf8');
        for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
            const target = match[1];
            if (/^[a-z]+:/i.test(target)) continue;
            const [relative, anchor] = target.split('#');
            const linked = posix.normalize(posix.join(posix.dirname(file), relative || posix.basename(file)));
            assert.ok(required.includes(linked), `Unpackaged documentation link: ${file} -> ${target}`);
            if (anchor) {
                const headings = [...readFileSync(join(root, linked), 'utf8').matchAll(/^#+ (.+)$/gm)]
                    .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
                assert.ok(headings.includes(decodeURIComponent(anchor)), `Missing documentation anchor: ${target}`);
            }
        }
    }
    const commands = ['README.md', 'README_zh.md'].map(name => [...readFileSync(join(root, name), 'utf8').matchAll(/```sh\n([\s\S]*?)```/g)].map(x => x[1].trim()).join('\n'));
    assert.equal(commands[0], commands[1]);
    writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, pack.filename)], temp);
    const installedLock = readJSON(join(temp, 'node_modules/.package-lock.json'));
    assert.deepEqual(Object.keys(installedLock.packages), ['node_modules/@nstdata-ai/proxy-checker']);
    const installed = join(temp, 'node_modules/@nstdata-ai/proxy-checker');
    assert.equal(readJSON(join(installed, 'package.json')).version, manifest.version);
    execFileSync(process.execPath, ['--input-type=module', '-e', "import {checkProxy,checkProxies} from '@nstdata-ai/proxy-checker'; import {createProxyTransport} from '@nstdata-ai/proxy-checker/transport'; if([checkProxy,checkProxies,createProxyTransport].some(x=>typeof x!=='function'))process.exit(1);"], { cwd: temp, timeout: 10000 });
    writeFileSync(join(temp, 'check.mts'), readFileSync(join(root, 'test/types.ts')));
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', '--typeRoots', join(root, 'node_modules/@types'), 'check.mts'], { cwd: temp, timeout: 30000 });
    execFileSync(process.execPath, [join(temp, 'node_modules/.bin/nstdata-proxy-checker'), '--help'], { cwd: temp, timeout: 10000 });
    execFileSync(process.execPath, ['--test', join(root, 'test/checker.test.mjs'), join(root, 'test/transport.test.mjs'), join(root, 'test/ip.test.mjs')], { cwd: temp,
        env: { ...process.env, NSTDATA_CHECKER_ROOT: installed }, timeout: 30000, stdio: 'inherit' });
    // The optional peer is supplied by the consumer; use a synthetic adapter for CLI and guide checks.
    const peer = join(temp, 'lookup-fixture'); mkdirSync(peer);
    writeFileSync(join(peer, 'package.json'), JSON.stringify({ name: '@nstdata-ai/ip-lookup', version: '1.0.0', type: 'module', main: 'index.js', types: 'index.d.ts' }));
    writeFileSync(join(peer, 'index.js'), `export async function lookupIp(ip) {
        return { source: 'synthetic-lookup', information: { query: ip, country: '=Example', as: 'AS64500 Example', proxy: false },
            retrievedAt: '2026-10-23T00:00:00.000Z', sourceUpdatedAt: null, cached: false };
    }`);
    writeFileSync(join(peer, 'index.d.ts'), 'export function lookupIp(ip: string, options?: {signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number; baseURL?: string}): Promise<unknown>;');
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', peer], temp);
    const samples = [];
    const guideCommands = [];
    for (const name of ['docs/guide.md', 'docs/guide_zh.md']) {
        const text = readFileSync(join(root, name), 'utf8');
        guideCommands.push([...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(x => x[1].trim()));
        const blocks = [...text.matchAll(/```js\n([\s\S]*?)```/g)];
        assert.equal(blocks.length, 3);
        for (const [index, block] of blocks.entries()) {
            const file = `${basename(name)}-${index}.mjs`;
            writeFileSync(join(temp, file), block[1]);
            samples.push({ file, checker: index !== 1, diagnostic: index === 2 });
        }
    }
    assert.deepEqual(guideCommands[0], guideCommands[1]);
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--allowJs', '--checkJs',
        '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', '--typeRoots',
        join(root, 'node_modules/@types'), ...samples.map(x => x.file)], { cwd: temp, timeout: 30000 });
    let status = 200, requests = 0;
    const gateway = http.createServer((req, res) => {
        requests++;
        assert.equal(req.method, 'GET');
        assert.ok(['http://fixture.invalid/', 'http://fixture.invalid/ip'].includes(req.url));
        res.writeHead(req.url.endsWith('/ip') ? 200 : status); res.end(req.url.endsWith('/ip') ? '203.0.113.7' : 'Example Domain');
    });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    try {
        for (const sample of samples) for (status of [200, 503]) {
            const start = requests;
            const options = { cwd: temp, timeout: 10000, env: { ...process.env,
                NSTDATA_PROXY_URL: `http://doc-user:doc-password@127.0.0.1:${gateway.address().port}`,
                NSTDATA_PROXY_CHECK_URL: 'http://fixture.invalid/', NSTDATA_PROXY_IP_ECHO_URL: 'http://fixture.invalid/ip' } };
            let output, exitCode = 0;
            try { output = await promisify(execFile)(process.execPath, [sample.file], options); }
            catch (error) {
                assert.ok(sample.checker && status === 503);
                assert.equal(error.code, 1);
                exitCode = error.code;
                output = error;
            }
            assert.equal(exitCode, sample.checker && status === 503 ? 1 : 0);
            assert.equal(requests - start, sample.diagnostic ? 2 : 1);
            assert.match(output.stdout, new RegExp(`statusCode: ${status}`));
            if (sample.checker) {
                assert.match(output.stdout, new RegExp(`ok: ${status === 200}`));
                if (status === 503) assert.match(output.stdout, /TARGET_HTTP_ERROR/);
            } else assert.match(output.stdout, /bodyBytes: 14/);
            assert.doesNotMatch(output.stdout + output.stderr, /doc-user|doc-password|Example Domain/);
        }
        status = 200;
        const before = requests;
        const cli = await promisify(execFile)(process.execPath, [join(installed, 'src/cli.js'), '--target', 'http://fixture.invalid/',
            '--ip-probe', 'http://fixture.invalid/ip', '--ip-info', '--format', 'csv'], { cwd: temp, timeout: 10000,
            env: { ...process.env, NSTDATA_PROXY_URL: `http://127.0.0.1:${gateway.address().port}` } });
        assert.equal(requests - before, 2);
        assert.match(cli.stdout, /separate-probe,203\.0\.113\.7,,,\x27=Example/);
        assert.equal(cli.stderr, '');
    } finally { await new Promise(resolve => gateway.close(resolve)); }
    console.log(`PASS: ${pack.name}@${pack.version}; ${required.length}-file allowlist; standalone offline install with no required runtime dependencies; public root/transport types and installed CLI/loopback/TLS tests; bilingual guide programs and packaged links`);
} finally { rmSync(temp, { recursive: true, force: true }); }

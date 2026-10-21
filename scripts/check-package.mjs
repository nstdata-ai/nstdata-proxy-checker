import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const required = ['package.json', 'src/index.js', 'src/index.d.ts', 'src/cli.js', 'src/config.js', 'src/transport.js', 'src/transport.d.ts',
        'README.md', 'README_zh.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md'];
    assert.deepEqual(pack.files.map(x => x.path).sort(), required.sort());
    for (const file of pack.files) assert.doesNotMatch(readFileSync(join(root, file.path), 'utf8'),
        /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bnpm_[a-zA-Z0-9]{30,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\/Users\/|_planning\//);
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
    execFileSync(process.execPath, ['--test', join(root, 'test/checker.test.mjs'), join(root, 'test/transport.test.mjs')], { cwd: temp,
        env: { ...process.env, NSTDATA_CHECKER_ROOT: installed }, timeout: 30000, stdio: 'inherit' });
    console.log(`PASS: ${pack.name}@${pack.version}; ${required.length}-file allowlist; standalone offline install with no runtime dependencies; public root/transport types and installed CLI/loopback/TLS tests`);
} finally { rmSync(temp, { recursive: true, force: true }); }

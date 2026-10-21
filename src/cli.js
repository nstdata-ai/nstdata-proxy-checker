#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { checkProxies, ProxyCheckError } from './index.js';

try {
    const { values } = parseArgs({ options: { file: { type: 'string' }, target: { type: 'string' },
        timeout: { type: 'string' }, concurrency: { type: 'string' }, format: { type: 'string' },
        'expected-text': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
    if (values.help) console.log('Usage: nstdata-proxy-checker --target <URL> [--file <protected JSON array>] [--timeout <ms>] [--concurrency <1-4>] [--format json|csv] [--expected-text <literal>]. Without --file, reads NSTDATA_PROXY_URL.');
    else {
        const format = values.format ?? 'json';
        if (!['json', 'csv'].includes(format)) throw new ProxyCheckError('INVALID_CONFIG');
        let proxies;
        if (values.file) {
            const info = await stat(values.file);
            if (!info.isFile() || info.size > 1048576) throw new ProxyCheckError('INVALID_INPUT_FILE');
            proxies = JSON.parse(await readFile(values.file, 'utf8'));
        } else proxies = [process.env.NSTDATA_PROXY_URL];
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
            const result = await checkProxies(proxies, { targetURL: values.target ?? process.env.NSTDATA_PROXY_CHECK_URL,
                timeoutMs: values.timeout === undefined ? 20000 : Number(values.timeout),
                concurrency: values.concurrency === undefined ? 1 : Number(values.concurrency),
                invalidInput: values.file ? 'report' : 'reject', expectedText: values['expected-text'],
                caFile: process.env.NSTDATA_PROXY_CA_FILE, signal: controller.signal });
            if (format === 'json') console.log(JSON.stringify(result));
            else {
                const columns = ['index', 'ok', 'protocol', 'probeRequested', 'statusCode', 'elapsedMs', 'observedIp', 'contentMatched', 'errorCode'];
                const cell = value => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
                process.stdout.write([columns.join(','), ...result.results.map(row => columns.map(key => cell(key === 'errorCode' ? row.error?.code : row[key])).join(','))].join('\r\n') + '\r\n');
            }
            process.exitCode = controller.signal.aborted ? 130 : result.failed ? 1 : 0;
        } finally {
            process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        }
    }
} catch (error) {
    console.error(JSON.stringify({ error: { code: error instanceof ProxyCheckError ? error.code : 'INVALID_INPUT' } }));
    process.exitCode = 2;
}

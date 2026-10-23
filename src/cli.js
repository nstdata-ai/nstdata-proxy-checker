#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { checkProxies, ProxyCheckError } from './index.js';

try {
    const { values } = parseArgs({ options: { file: { type: 'string' }, target: { type: 'string' },
        timeout: { type: 'string' }, concurrency: { type: 'string' }, format: { type: 'string' },
        'expected-text': { type: 'string' }, 'ip-probe': { type: 'string' }, 'ip-info': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' } }, strict: true });
    if (values.help) console.log('Usage: nstdata-proxy-checker --target <URL> [--file <protected JSON array>] [--timeout <ms>] [--concurrency <1-4>] [--format json|csv] [--expected-text <literal>] [--ip-probe <IP echo URL>] [--ip-info]. Without --file, reads NSTDATA_PROXY_URL. --ip-probe adds one proxy GET per entry. --ip-info requires @nstdata-ai/ip-lookup and explicitly queries the observed IP through its service.');
    else {
        const format = values.format ?? 'json';
        if (!['json', 'csv'].includes(format)) throw new ProxyCheckError('INVALID_CONFIG');
        let proxies;
        if (values.file) {
            const info = await stat(values.file);
            if (!info.isFile() || info.size > 1048576) throw new ProxyCheckError('INVALID_INPUT_FILE');
            proxies = JSON.parse(await readFile(values.file, 'utf8'));
        } else proxies = [process.env.NSTDATA_PROXY_URL];
        let lookupIp;
        if (values['ip-info']) {
            try { ({ lookupIp } = await import('@nstdata-ai/ip-lookup')); }
            catch { throw new ProxyCheckError('IP_LOOKUP_NOT_INSTALLED'); }
            if (typeof lookupIp !== 'function') throw new ProxyCheckError('IP_LOOKUP_NOT_INSTALLED');
        }
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
            const result = await checkProxies(proxies, { targetURL: values.target ?? process.env.NSTDATA_PROXY_CHECK_URL,
                timeoutMs: values.timeout === undefined ? 20000 : Number(values.timeout),
                concurrency: values.concurrency === undefined ? 1 : Number(values.concurrency),
                invalidInput: values.file ? 'report' : 'reject', expectedText: values['expected-text'],
                caFile: process.env.NSTDATA_PROXY_CA_FILE, signal: controller.signal,
                ipProbeURL: values['ip-probe'], lookupIp: lookupIp && ((ip, options) => lookupIp(ip, {
                    ...options, baseURL: process.env.NSTDATA_IP_LOOKUP_BASE_URL,
                })) });
            if (format === 'json') console.log(JSON.stringify(result));
            else {
                const columns = ['index', 'ok', 'protocol', 'probeRequested', 'statusCode', 'elapsedMs', 'observedIp', 'contentMatched', 'errorCode'];
                const extra = values['ip-probe'] !== undefined || values['ip-info'];
                if (extra) columns.push('ipSource', 'exitIp', 'ipProbeErrorCode', 'ipLookupErrorCode', 'country', 'regionName', 'city', 'isp', 'as', 'ipLookupStatusCode');
                const cell = value => { let text = value == null ? '' : String(value); if (/^\s*[=+@-]/u.test(text)) text = "'" + text; return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
                process.stdout.write([columns.join(','), ...result.results.map(row => {
                    const details = row.ip?.lookup?.ok ? row.ip.lookup.result.information : {};
                    const output = { ...row, errorCode: row.error?.code, ipSource: row.ip?.source, exitIp: row.ip?.observedIp,
                        ipProbeErrorCode: row.ip?.probe?.error?.code, ipLookupErrorCode: row.ip?.lookup?.error?.code,
                        country: details.country, regionName: details.regionName, city: details.city, isp: details.isp, as: details.as,
                        ipLookupStatusCode: row.ip?.lookup?.error?.statusCode };
                    return columns.map(key => cell(output[key])).join(',');
                })].join('\r\n') + '\r\n');
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

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { checkProxies, ProxyCheckError } from './index.js';
import { validateSettings, validateRequest } from './config.js';
import { createProxyTransport } from './transport.js';

class CliInputError extends ProxyCheckError {
    constructor(code, message, exitCode = 2) { super(code); this.message = message; this.exitCode = exitCode; }
}

function validateInput(check, message) {
    try { return check(); }
    catch { throw new CliInputError('INVALID_CONFIG', message); }
}

function apiDiagnostics(error) {
    const details = {};
    if (Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599)
        details.statusCode = error.statusCode;
    if (Number.isSafeInteger(error.applicationCode)) details.applicationCode = error.applicationCode;
    if (error.code !== 'HTTP_ERROR' && error.code !== 'API_ERROR') return details;
    const status = error.code === 'API_ERROR' ? details.applicationCode : details.statusCode;
    if (status === 401) details.hint = 'Check NSTDATA_API_TOKEN and its account or team context.';
    else if (status === 403) details.hint = 'Check the API key permissions and account or team access.';
    else if (status === 429) details.hint = 'The API rate limit was reached. Wait before starting another command.';
    else if (status >= 500 && status <= 599) details.hint = 'The API returned a service error. Check its status before another command.';
    return details;
}

async function nstdataProxy(values, timeoutMs, signal) {
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !values.yes);
    let apiKey = process.env.NSTDATA_API_TOKEN;
    const question = async (prompt, hidden = false) => {
        const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stderr;
        const reader = createInterface({ input: process.stdin, output, terminal: true });
        reader.once('SIGINT', () => process.kill(process.pid, 'SIGINT'));
        const closed = new Promise((_, reject) => reader.once('close', () =>
            reject(new CliInputError('ABORTED', 'Input closed; no automatic retry was made.', 130))));
        try {
            const answer = reader.question('', { signal });
            process.stderr.write(prompt);
            return (await Promise.race([answer, closed])).trim();
        } catch (error) {
            if (signal.aborted) throw new CliInputError('ABORTED', 'Input cancelled; no automatic retry was made.', 130);
            throw error;
        } finally { reader.close(); if (hidden) process.stderr.write('\n'); }
    };
    if (!apiKey && interactive) apiKey = await question('Nstdata API key (hidden): ', true);
    if (!apiKey) throw new CliInputError('MISSING_API_KEY',
        'Set NSTDATA_API_TOKEN or use --env; interactive API key input is hidden.');
    if (!interactive && !values.yes)
        throw new CliInputError('CONFIRMATION_REQUIRED', 'Use --yes to allow Nstdata channel setup, one connection and one target check.');
    const { ProxyClient, ProxyAPIError } = await import('@nstdata-ai/proxy');
    try {
        const client = new ProxyClient({ apiKey,
            baseUrl: process.env.NSTDATA_API_BASE_URL, teamId: process.env.NSTDATA_TEAM_ID, timeoutMs });
        apiKey = undefined;
        const input = { country: values.country, channelId: values.channel };
        const plan = await client.prepareProxy(input, { signal });
        if (interactive) {
            process.stderr.write(`\nProduct: ${plan.zoneName} (${plan.type})\nCountry: ${plan.country}\n` +
                `Reference price: ${plan.priceGB}/GB; balance: ${plan.balance}\n` +
                `Channel: ${plan.channelAction === 'create' ? 'create reusable SDK default' : 'reuse selected channel'}\n` +
                'Generate one HTTP connection, then check the selected target; proxy traffic is metered.\n');
            while (true) {
                const answer = (await question('[Enter] Continue, [q] Cancel: ')).toLowerCase();
                if (answer === 'q') throw new CliInputError('ABORTED', 'Cancelled before channel setup or generation.', 130);
                if (answer === '') break;
                process.stderr.write('Press Enter to continue or q to cancel.\n');
            }
        }
        const result = await client.getProxy(input, { signal });
        return result.url;
    } catch (error) {
        if (error instanceof CliInputError) throw error;
        if (signal.aborted) throw new CliInputError('ABORTED', 'Local waiting stopped; submitted operations may still complete. Do not blindly repeat setup.', 130);
        if (error instanceof ProxyAPIError) throw Object.assign(
            new CliInputError(error.code, error.message, error.code === 'ABORTED' ? 130 : 1), apiDiagnostics(error));
        throw new CliInputError('SETUP_FAILED', 'Nstdata setup failed; no automatic retry was made.', 1);
    }
}

const help = `Usage: nstdata-proxy-checker --target <URL> [options]

Setup:
  Set NSTDATA_PROXY_URL to your HTTP/HTTPS proxy URL before running a check.
  Use the full URL generated by your proxy provider, including any credentials.
  Alternatively, use --file to read a JSON array of proxy URLs.
  Or use --nstdata with your Nstdata API key to obtain one proxy and check it.
  No Crawl API key or additional server is required.

Options:
  --target <URL>           Target HTTP/HTTPS URL; or set NSTDATA_PROXY_CHECK_URL
  --file <path>            JSON array of 1-100 proxy URLs; overrides NSTDATA_PROXY_URL
  --timeout <ms>           Per-request timeout, 1-600000 (default: 20000)
  --concurrency <1-4>      Batch concurrency (default: 1)
  --format <json|csv>     Output format (default: json)
  --expected-text <text>  Require this literal text in the target response
  --ip-probe <URL>        Extra proxy GET to an IP echo service
  --ip-info               Look up the observed IP; requires @nstdata-ai/ip-lookup
  --nstdata               Obtain one HTTP proxy using Nstdata, then check it
  --yes                   Accept Nstdata setup without interactive confirmation
  --env <path>            Load an explicit environment file with --nstdata
  --country <code>        Require a supported country with --nstdata
  --channel <id>          Use an existing Nstdata channel with --nstdata
  -h, --help              Show help without sending requests

Environment:
  NSTDATA_PROXY_URL        HTTP/HTTPS proxy URL (unless --file or --nstdata is used)
  NSTDATA_PROXY_CHECK_URL  Target URL when --target is omitted
  NSTDATA_PROXY_CA_FILE    Optional absolute path to an additional trusted PEM CA file
  NSTDATA_IP_LOOKUP_BASE_URL  Optional IP lookup service override for --ip-info
  NSTDATA_API_TOKEN        Nstdata API key; prompted with hidden input in a terminal
  NSTDATA_TEAM_ID          Optional team context for --nstdata
  NSTDATA_API_BASE_URL     Advanced API origin override for --nstdata

Examples:
  Replace the example proxy URL with the one generated by your provider:
    export NSTDATA_PROXY_URL='http://user:password@proxy.example:8080'
    nstdata-proxy-checker --target https://example.com/ --timeout 20000
  With a protected JSON file containing proxy URLs:
    nstdata-proxy-checker --file proxies.json --target https://example.com/ --format csv
  With an Nstdata API key and available balance:
    nstdata-proxy-checker --nstdata
    nstdata-proxy-checker --nstdata --env .env --yes

Exit codes: 0 checks passed; 1 checks failed; 2 invalid input; 130 interrupted.
Checks use proxy traffic. Requests are not retried or redirected.
--nstdata may create a reusable default channel; it never purchases a package.
Its default target is https://example.com/; --target overrides it.
--nstdata ignores NSTDATA_PROXY_URL. Other modes never read your API key.`;

try {
    const { values } = parseArgs({ options: { file: { type: 'string' }, target: { type: 'string' },
        timeout: { type: 'string' }, concurrency: { type: 'string' }, format: { type: 'string' },
        'expected-text': { type: 'string' }, 'ip-probe': { type: 'string' }, 'ip-info': { type: 'boolean' },
        nstdata: { type: 'boolean' }, yes: { type: 'boolean' }, env: { type: 'string' },
        country: { type: 'string' }, channel: { type: 'string' },
        help: { type: 'boolean', short: 'h' } }, strict: true });
    if (values.help) console.log(help);
    else {
        if (values.nstdata && values.file !== undefined)
            throw new CliInputError('INVALID_CONFIG', 'Choose --nstdata or --file, not both.');
        if (!values.nstdata && ['yes', 'env', 'country', 'channel'].some(key => values[key] !== undefined))
            throw new CliInputError('INVALID_CONFIG', '--yes, --env, --country and --channel require --nstdata.');
        if (values.env !== undefined) {
            try { process.loadEnvFile(values.env); }
            catch { throw new CliInputError('INVALID_CONFIG', '--env must name a readable environment file.'); }
        }
        const format = values.format ?? 'json';
        if (!['json', 'csv'].includes(format)) throw new CliInputError('INVALID_CONFIG', '--format must be json or csv.');
        const targetURL = values.target ?? process.env.NSTDATA_PROXY_CHECK_URL ?? (values.nstdata ? 'https://example.com/' : undefined);
        validateInput(() => validateRequest({ url: targetURL }),
            '--target or NSTDATA_PROXY_CHECK_URL must be an HTTP/HTTPS URL without credentials.');
        const timeoutMs = values.timeout === undefined ? 20000 : Number(values.timeout);
        validateInput(() => validateSettings({ proxyURL: 'http://127.0.0.1:1', timeoutMs }),
            '--timeout must be an integer from 1 to 600000 milliseconds.');
        const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
            throw new CliInputError('INVALID_CONFIG', '--concurrency must be an integer from 1 to 4.');
        if (values['expected-text'] !== undefined &&
            (!values['expected-text'].length || Buffer.byteLength(values['expected-text']) > 4096))
            throw new CliInputError('INVALID_CONFIG', '--expected-text must be non-empty and at most 4096 UTF-8 bytes.');
        if (values['ip-probe'] !== undefined) validateInput(() => validateRequest({ url: values['ip-probe'] }),
            '--ip-probe must be an HTTP/HTTPS URL without credentials.');
        const caFile = process.env.NSTDATA_PROXY_CA_FILE;
        validateInput(() => validateSettings({ proxyURL: 'http://127.0.0.1:1', caFile }),
            'NSTDATA_PROXY_CA_FILE must be an absolute path to a PEM CA file.');
        if (values.nstdata && caFile) validateInput(() => createProxyTransport({ proxyURL: 'http://127.0.0.1:1', caFile }),
            'NSTDATA_PROXY_CA_FILE must name a readable PEM CA file.');
        let proxies;
        if (values.file !== undefined) {
            try {
                const info = await stat(values.file);
                if (!info.isFile() || info.size > 1048576) throw new CliInputError('INVALID_INPUT_FILE', '--file must be a UTF-8 JSON file no larger than 1 MiB.');
                const content = await readFile(values.file);
                if (content.length > 1048576 || !isUtf8(content)) throw new CliInputError('INVALID_INPUT_FILE', '--file must be a UTF-8 JSON file no larger than 1 MiB.');
                proxies = JSON.parse(content.toString('utf8'));
            } catch (error) {
                if (error instanceof CliInputError) throw error;
                throw new CliInputError('INVALID_INPUT', '--file must point to a readable JSON file containing proxy URLs.');
            }
            if (!Array.isArray(proxies) || proxies.length < 1 || proxies.length > 100)
                throw new CliInputError('INVALID_CONFIG', '--file must contain a JSON array of 1-100 proxy URLs.');
        } else if (!values.nstdata) {
            const proxyURL = process.env.NSTDATA_PROXY_URL;
            if (!proxyURL?.trim()) throw new CliInputError('INVALID_CONFIG',
                'NSTDATA_PROXY_URL is not set. Set it to your proxy URL, or use --file <path>.');
            validateInput(() => validateSettings({ proxyURL }),
                'NSTDATA_PROXY_URL must be a valid HTTP/HTTPS proxy URL. Use the URL generated by your provider.');
            proxies = [proxyURL];
        }
        let lookupIp;
        if (values['ip-info']) {
            try { ({ lookupIp } = await import('@nstdata-ai/ip-lookup')); }
            catch { throw new CliInputError('IP_LOOKUP_NOT_INSTALLED', '--ip-info requires @nstdata-ai/ip-lookup installed alongside this package.'); }
            if (typeof lookupIp !== 'function') throw new CliInputError('IP_LOOKUP_NOT_INSTALLED', '--ip-info requires a compatible @nstdata-ai/ip-lookup package.');
        }
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
            if (values.nstdata) proxies = [await nstdataProxy(values, timeoutMs, controller.signal)];
            const result = await checkProxies(proxies, { targetURL, timeoutMs, concurrency,
                invalidInput: values.file !== undefined ? 'report' : 'reject', expectedText: values['expected-text'],
                caFile, signal: controller.signal,
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
    const code = error instanceof ProxyCheckError ? error.code : 'INVALID_INPUT';
    const message = error instanceof CliInputError ? error.message
        : 'Invalid command-line arguments or input. Run nstdata-proxy-checker --help for usage.';
    console.error(JSON.stringify({ error: { code, message, ...(error instanceof CliInputError ? apiDiagnostics(error) : {}) } }));
    process.exitCode = error instanceof CliInputError ? error.exitCode : 2;
}

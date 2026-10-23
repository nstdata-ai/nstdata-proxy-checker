import { checkProxy, checkProxies, ProxyCheckError, type CheckResult } from '@nstdata-ai/proxy-checker';
import { createProxyTransport, ProxyTransportError, type ProxyResponse } from '@nstdata-ai/proxy-checker/transport';

async function consumer() {
    const options = { targetURL: 'https://target.invalid/', signal: new AbortController().signal };
    const single: CheckResult = await checkProxy('http://gateway.invalid:8080', options);
    const diagnostic = await checkProxy('http://gateway.invalid:8080', { ...options,
        ipProbeURL: 'https://echo.invalid/', lookupIp: async (_ip, { signal, timeoutMs }) => {
            const active: AbortSignal = signal;
            const timeout: number = timeoutMs;
            return { active, timeout };
        } });
    if (diagnostic.ip?.lookup?.ok) {
        const country: string | null | undefined = diagnostic.ip.lookup.result.information.country;
        void country;
    }
    const batch = await checkProxies(['http://gateway.invalid:8080', null], { ...options, invalidInput: 'report' });
    const transport = createProxyTransport({ proxyURL: 'http://gateway.invalid:8080' });
    const response: ProxyResponse = await transport.request({ url: options.targetURL, method: 'HEAD' }, { signal: options.signal });
    const bytes: Buffer = response.body;
    // @ts-expect-error Mutating methods are unsupported.
    void transport.request({ url: options.targetURL, method: 'POST' });
    return { single, batch, bytes, diagnostic };
}
const code: string = new ProxyCheckError('INVALID_CONFIG').code;
const details: Record<string, unknown> = new ProxyTransportError('UPSTREAM_ERROR', 'Safe error').details;
void consumer; void code; void details;

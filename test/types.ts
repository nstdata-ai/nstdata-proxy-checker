import { checkProxy, checkProxies, ProxyCheckError, type CheckResult } from '@nstdata-ai/proxy-checker';
import { createProxyTransport, ProxyTransportError, type ProxyResponse } from '@nstdata-ai/proxy-checker/transport';

async function consumer() {
    const options = { targetURL: 'https://target.invalid/', signal: new AbortController().signal };
    const single: CheckResult = await checkProxy('http://gateway.invalid:8080', options);
    const batch = await checkProxies(['http://gateway.invalid:8080', null], { ...options, invalidInput: 'report' });
    const transport = createProxyTransport({ proxyURL: 'http://gateway.invalid:8080' });
    const response: ProxyResponse = await transport.request({ url: options.targetURL, method: 'HEAD' }, { signal: options.signal });
    const bytes: Buffer = response.body;
    // @ts-expect-error Mutating methods are unsupported.
    void transport.request({ url: options.targetURL, method: 'POST' });
    return { single, batch, bytes };
}
const code: string = new ProxyCheckError('INVALID_CONFIG').code;
const details: Record<string, unknown> = new ProxyTransportError('UPSTREAM_ERROR', 'Safe error').details;
void consumer; void code; void details;

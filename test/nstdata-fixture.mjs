import assert from 'node:assert/strict';
import http from 'node:http';
import { listen } from './proxy-fixtures.mjs';

export const apiKey = 'checker-synthetic-api-key';

export async function nstdataFixture(t, overrides = {}) {
    const state = { balance: 20, channels: [], requests: [], probes: [], status: 200, ...overrides };
    const gateway = http.createServer((req, res) => {
        state.probes.push(req.url);
        assert.equal(req.method, 'GET');
        res.writeHead(state.status); res.end('Example Domain');
    });
    gateway.on('connect', (req, socket, head) => {
        state.probes.push(req.url);
        if (state.connect) { state.connect(req, socket, head); return; }
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    });
    const gatewayPort = await listen(t, gateway);
    const proxyURL = `http://fixture-user:fixture-password@127.0.0.1:${gatewayPort}`;
    const api = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let body = ''; for await (const chunk of req) body += chunk;
        state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
        assert.equal(req.headers['x-api-key'], apiKey);
        if (state.handle && await state.handle(req, res, url, body)) return;
        let data;
        if (url.pathname.endsWith('/user/info')) data = { balance: state.balance };
        else if (url.pathname.endsWith('/plan/info')) data = [
            { name: 'lite', type: 'residential_lite', protocols: ['http'], priceGB: 2, supports: ['country'] },
        ];
        else if (url.pathname.endsWith('/region/country')) data = [{ value: 'US' }, { value: 'GB' }];
        else if (url.pathname.endsWith('/channels')) {
            const selectors = [...url.searchParams].filter(([key]) => !['page', 'pageSize'].includes(key));
            const rows = state.channels.filter(row => selectors.every(([key, value]) => String(row[key]) === value));
            const size = Number(url.searchParams.get('pageSize') ?? 100);
            const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * size;
            data = rows.slice(offset, offset + size);
        } else if (url.pathname.endsWith('/channel') && req.method === 'POST') {
            data = { ...JSON.parse(body), channelId: 'fixture-channel', status: 1, used: 0 };
            state.channels.push(data);
        } else if (url.pathname.includes('/channel/')) data = state.channels.filter(row => row.channelId === url.pathname.split('/').at(-1));
        else if (url.pathname.endsWith('/proxies')) data = { proxies: [state.generatedURL ?? proxyURL], count: 1 };
        else { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data, code: 200, err: false }));
    });
    const port = await listen(t, api);
    return { state, proxyURL, env: { NSTDATA_API_TOKEN: apiKey, NSTDATA_API_BASE_URL: `http://127.0.0.1:${port}` } };
}

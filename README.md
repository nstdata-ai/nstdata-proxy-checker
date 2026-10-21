# Nstdata proxy checker

[中文](README_zh.md)

HTTP/HTTPS proxy checks as a Node.js CLI and library. No runtime dependencies, hosted checker or Crawl token are required. Supports Node.js 22.18+ in the 22.x line, or Node.js 24.

## Install

Version `1.1.0` is prepared locally and has not been published. After publication, install it in your application directory:

```sh
npm install @nstdata-ai/proxy-checker@1.1.0
```

For local installation before publication, see [Contributing](CONTRIBUTING.md).

## Check proxies

Set `NSTDATA_PROXY_URL` to the generated proxy URL in a protected environment, then choose a target:

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --timeout 20000
```

`--file` accepts a protected JSON array of 1–100 proxy URLs, at most 1 MiB, and overrides the environment proxy. Use owner-only file permissions. Invalid entries produce indexed `INVALID_CONFIG` rows; valid entries continue. Malformed documents or common options reject the invocation.

Each entry sends one GET, including duplicate URLs. HTTPS targets use CONNECT. Requests may consume traffic; there is no redirect, retry, rotation or direct fallback. HTTP/HTTPS gateways and generated username/session syntax are supported; this tool does not manage channels or verify PM routing.

| Option | Default / behavior |
|---|---|
| `--target` | Required, or `NSTDATA_PROXY_CHECK_URL` |
| `--timeout` | 20000 ms per probe; range 1–600000 |
| `--concurrency` | 1; range 1–4 |
| `--format` | `json` or `csv` |
| `--expected-text` | Optional case-sensitive literal, up to 4096 UTF-8 bytes |
| `NSTDATA_PROXY_CA_FILE` | Optional absolute PEM CA path; TLS verification remains enabled |

Exit codes: 0 all rows pass; 1 at least one failed row; 2 invalid document/configuration; 130 interrupted. SIGINT/SIGTERM stops active and queued work. `probeRequested` means a local transport request was initiated, not proof that a request reached the target.

## Content checks and output

```sh
npx --no-install nstdata-proxy-checker --file /PATH/TO/proxies.json --target https://example.com/ --expected-text "Example Domain" --format csv
```

A 2xx response alone establishes HTTP health, not expected content. Assertion mode checks complete valid UTF-8 text with one GET. Invalid UTF-8 returns `CONTENT_UNAVAILABLE` with unknown match status; default HTTP health checks remain based on status. A mismatch returns `CONTENT_MISMATCH`; non-2xx remains `TARGET_HTTP_ERROR`. Redacted/unavailable content returns unknown match status rather than scoring modified text. There is no regex or Unicode/whitespace normalization.

JSON contains aggregate counts and ordered rows. CSV uses `index,ok,protocol,probeRequested,statusCode,elapsedMs,observedIp,contentMatched,errorCode`, one row per input. Missing CSV values are blank. Output never contains proxy URLs, credentials or response bodies.

`elapsedMs` measures the transport request through complete body decoding, excluding transport setup and content assessment. It excludes the former MCP call overhead; compare results produced by the same version and mode. It is not TCP time, TTFB or throughput. `observedIp` is populated only from a valid IP echo; normal HTML leaves it null. Status/timing/match values may be unknown.

## Library

```js
import { checkProxy, checkProxies } from '@nstdata-ai/proxy-checker';
const one = await checkProxy(process.env.NSTDATA_PROXY_URL, {
  targetURL: 'https://example.com/', timeoutMs: 20000,
});
// checkProxies([url1, url2], {targetURL, concurrency:2, signal}) preserves order.
```

`checkProxies` preserves order and accepts `invalidInput: 'reject'` (default) or `'report'`. Strict mode rejects invalid URLs before any request. Other options are `maxResponseBytes` (default 1 MiB, range 256–64 MiB), `caFile`, `signal` and `expectedText`. Common options are validated before dispatch. Use a signal to bound the whole batch; timeout is per probe.

Body size and assertion output are independently bounded; assertion mode retains a 16000-character serialized-response cap. A response-limit or output-limit failure is not a successful assertion. TLS/auth/CONNECT errors remain separate from target HTTP failures.

## Reusable transport

```js
import { createProxyTransport } from '@nstdata-ai/proxy-checker/transport';
const transport = createProxyTransport({ proxyURL: process.env.NSTDATA_PROXY_URL, timeoutMs: 20000 });
const response = await transport.request({ url: 'https://example.com/', method: 'GET' });
// response: statusCode, body (Buffer), headers
```

The transport supports GET/HEAD and optional target headers. It rejects connection/proxy header overrides, follows no redirects and performs no retries or direct fallback. Each request has its own deadline and optional `signal`; `maxResponseBytes` bounds downloaded and decoded bodies. `caFile` adds a trusted PEM CA while retaining gateway and target hostname verification. Transport failures expose safe `ProxyTransportError` codes; HTTP target statuses remain response data. Gateway/CONNECT 407 means proxy authentication failed; a 407 from the HTTPS target inside an established tunnel remains a target response.

Unlike CLI results, transport bodies and headers are **unredacted, untrusted data**. Callers must apply their own output/credential filtering before logging or exposing them to an AI client. The MCP adapter supplies those policies separately.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

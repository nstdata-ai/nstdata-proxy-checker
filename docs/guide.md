# Proxy Checker usage guide

[Back to quick start](../README.md) · [中文](guide_zh.md)

[Connections](#connections) · [CLI and batches](#cli-and-batches) · [Content and results](#content-and-results) · [Checking library](#checking-library) · [Shared transport](#shared-transport) · [Exit information](#exit-ip-and-information) · [Errors](#errors)

## Connections

Use the platform-generated `http://` or `https://` proxy URL, with URL-encoded username/password when present. Keep it in `NSTDATA_PROXY_URL` or a protected file instead of command-line arguments. HTTP/HTTPS gateways and HTTP/HTTPS targets are supported; HTTPS targets use CONNECT.

SOCKS, browser interaction, channel management and automatic rotation are unsupported. TLS certificates and hostnames remain verified. Add a private CA using the absolute `NSTDATA_PROXY_CA_FILE` path (CLI) or `caFile` (library), without disabling verification.

## CLI and batches

### Input and output

A single proxy uses the environment variable. `--file` accepts a JSON array of 1–100 proxy URLs, at most 1 MiB; keep the file owner-readable/writable only. File input overrides `NSTDATA_PROXY_URL`. Invalid rows retain their index and report `INVALID_CONFIG`; valid rows continue.

```sh
npx --no-install nstdata-proxy-checker --file /path/to/proxies.json --target https://example.com/ --concurrency 2 --format csv
```

| Option / environment | Default | Purpose and limits |
|---|---|---|
| `--target` / `NSTDATA_PROXY_CHECK_URL` | One required | Target HTTP(S) URL without credentials; CLI wins |
| `NSTDATA_PROXY_URL` | None | Proxy URL when `--file` is absent |
| `--file` | None | Protected JSON proxy-array file |
| `--timeout` | 20000 ms | Per-probe deadline, integer 1–600000 |
| `--concurrency` | 1 | Integer 1–4 |
| `--format` | `json` | `json` or `csv` output |
| `--expected-text` | None | Nonempty, case-sensitive literal, at most 4096 UTF-8 bytes |
| `NSTDATA_PROXY_CA_FILE` | None | Absolute path to an additional trusted PEM CA |
| `--ip-probe` | None | One extra proxy GET; supports plain IP, JSON `ip` or successful Nstdata `data.ip` envelopes |
| `--ip-info` | Off | Query the observed IP using the optional `@nstdata-ai/ip-lookup` package |
| `NSTDATA_IP_LOOKUP_BASE_URL` | Lookup package default | CLI lookup service address; does not change the proxy target |
| `--help` / `-h` | — | Print usage without a probe |

JSON returns `total/succeeded/failed/results` in input order. CSV has one row per input with default columns `index,ok,protocol,probeRequested,statusCode,elapsedMs,observedIp,contentMatched,errorCode`; unknown values are blank. Output omits proxy URLs, credentials and response bodies.

| Exit | Meaning |
|---|---|
| 0 | All target checks pass; extra probe/lookup failures are reported independently |
| 1 | At least one failed row, including invalid file entries or CA-loading failures |
| 2 | Invocation rejected, such as invalid document or common arguments |
| 130 | SIGINT/SIGTERM interruption stops active and queued work |

### Content assertions

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --expected-text "Example Domain"
```

## Content and results

By default, HTTP health means a 2xx response. Assertions use the complete valid UTF-8 body from the same GET for case-sensitive literal matching, without regex, Unicode or whitespace normalization.

| Field | Type | Meaning |
|---|---|---|
| `ok` | `boolean` | HTTP success and, if requested, successful assertion |
| `index` | `number`, batch rows | Input position; duplicates are separate probes |
| `protocol` | `http` / `https` / `null` or absent | Gateway protocol, not target protocol |
| `probeRequested` | `boolean` | Local transport invocation began; not proof of target arrival |
| `statusCode` | `number` / `null` | HTTP status of a completely obtained response, otherwise unknown |
| `elapsedMs` | `number` / `null` | Transport invocation through complete body decoding, excluding setup, assertion and MCP overhead |
| `observedIp` | `string` / `null` | Valid plain-IP, JSON `ip` or successful Nstdata `data.ip` echoes; normal HTML remains unknown |
| `contentMatched` | `boolean` / `null` or absent | Present when asserting; null means no reliable assessment |
| `error.code` | `string`, on failure | Failure category, below |

Duration is not TCP time, TTFB or throughput; compare the same version and mode. An IP echo does not prove location, reputation or anonymity.

Invalid UTF-8, credential-bearing or redaction-marker text cannot count as a content pass. Assertion assessment retains a 16000-character serialized-response cap; exceeding it leaves the match unknown while preserving completed HTTP status and duration. A complete non-2xx response takes precedence as `TARGET_HTTP_ERROR`. Downloaded/decoded byte-limit failures lack a complete result and produce `RESPONSE_LIMIT`.

## Checking library

This is a complete ESM example. HTTPS is the default target; `NSTDATA_PROXY_CHECK_URL` can select another authorized target.

```js
import { checkProxy } from '@nstdata-ai/proxy-checker';

const proxyURL = process.env.NSTDATA_PROXY_URL;
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
const result = await checkProxy(proxyURL, {
    targetURL: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
    timeoutMs: 20000,
    expectedText: 'Example Domain',
});
console.log(result);
if (!result.ok) process.exitCode = 1;
```

| Function | Returns | Input handling |
|---|---|---|
| `checkProxy(proxyURL, options)` | `Promise<CheckResult>` | Invalid options throw `ProxyCheckError`; probe failures return `ok: false` |
| `checkProxies(proxies, options)` | `Promise<{total, succeeded, failed, results}>` | 1–100 entries, preserving order and duplicates with bounded concurrency |

Common options are required `targetURL`, and optional `timeoutMs`, `expectedText`, `caFile`, `signal`, `maxResponseBytes`. The response limit defaults to 1 MiB, range 256–67108864 bytes; timeout defaults to 20000 ms, range 1–600000.

Batch options add `concurrency` (default 1, range 1–4) and `invalidInput`: default `'reject'` validates all proxies before requests; `'report'` keeps invalid rows and probes valid entries. Shared option formats/ranges are checked before dispatch. CA file/trust-loading failures return `INVALID_CONFIG` rows with `probeRequested: false`.

A `signal` cancels local waiting for a call or batch. Per-probe timeouts exclude queue waiting. Use `AbortSignal.timeout(...)` to bound the entire batch when needed.

## Shared transport

`/transport` is for callers processing responses themselves. It supports GET/HEAD and target headers. This example prints only status and byte count:

```js
import { createProxyTransport, ProxyTransportError } from '@nstdata-ai/proxy-checker/transport';

const proxyURL = process.env.NSTDATA_PROXY_URL;
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
try {
    const transport = createProxyTransport({ proxyURL, timeoutMs: 20000 });
    const response = await transport.request({
        url: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
        method: 'GET',
    });
    console.log({ statusCode: response.statusCode, bodyBytes: response.body.length });
} catch (error) {
    console.error(error instanceof ProxyTransportError ? error.code : 'TRANSPORT_ERROR');
    process.exitCode = 1;
}
```

| Input / output | Meaning |
|---|---|
| `createProxyTransport({proxyURL, timeoutMs?, maxResponseBytes?, caFile?})` | Local configuration; invalid settings throw `ProxyTransportError` |
| `request({url, method?, headers?}, {signal}?)` | GET by default; HEAD has no body; connection/proxy-specific headers cannot be overridden |
| `{statusCode, body, headers}` | `body` is a completely decoded `Buffer`; original headers may describe its encoded wire representation |

Gateway and target certificates remain verified, with `caFile` adding trust. Each request has a deadline; downloaded and decoded bodies are size-bounded. There are no redirects, retries or direct fallback.

**Bodies and headers are unredacted, untrusted data.** Filter them before logs, terminals or AI clients. `checkProxy` does not return these raw contents. Target non-2xx statuses remain response data rather than transport scoring. Gateway/CONNECT 407 means proxy-auth failure; a 407 from an HTTPS target inside an established tunnel is a target HTTP response.

## Exit IP and information

### CLI

The default check visits the target once; ordinary HTML does not reveal an exit IP. To keep the target check and add an exit probe, use the public Nstdata echo endpoint:

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --ip-probe https://api.nstdata.io/api/v2/public/utility/client-ip
```

Location/ISP/ASN lookup is optional. Install the lookup package in the same application. The installation command applies after its publication; see Contributing for local archive installation before publication.

```sh
npm install @nstdata-ai/ip-lookup@1.0.0
npx --no-install nstdata-proxy-checker --target https://example.com/ --ip-probe https://api.nstdata.io/api/v2/public/utility/client-ip --ip-info
```

You can choose another authorized echo URL. Supported responses are a plain IPv4/IPv6 address, `{"ip":"address"}`, or a Nstdata envelope with `code=200,err=false,data.ip`. Other content stays unknown.

`--ip-info` queries only an observed IP. Omit `--ip-probe` if the target itself returns an IP to reuse that response. Ordinary content, failed echo responses or missing IPs never trigger lookup. A missing optional package produces `IP_LOOKUP_NOT_INSTALLED` before any network request. The default installation does not install the lookup package.

Lookup contacts Nstdata through the lookup package with the explicit observed IP. It does not reuse the tested proxy transport or its credentials. Service rate limits and data-use conditions apply independently; batches can have partial lookup failures. No automatic retries, retry queue or provider fallback are added. Review service and data-use terms before using lookup results.

### Results

Existing top-level `observedIp`, `statusCode`, `elapsedMs` and `ok` always describe the target check. IP options add an `ip` object:

| Field | Meaning |
|---|---|
| `ip.source` | `target-response` reuses the target response; `separate-probe` is another echo request |
| `ip.observedIp` | IP from a successful 2xx response, or null when unavailable |
| `ip.probe` | Extra echo request only, with its own status, timing and error |
| `ip.lookup.requested` | Whether the lookup function was invoked, not proof of arrival at the service |
| `ip.lookup.ok` | Lookup success, independent of target health |
| `ip.lookup.result` | Source, retrieval/source timestamps, cache marker and validated information summary |
| `ip.lookup.error.code` | Failure or skip reason, such as `IP_NOT_OBSERVED`, `HTTP_ERROR` or `TIMEOUT`; service errors also retain valid `statusCode`/`apiCode` |

The summary keeps `query` and available country, country code, region, city, timezone, ISP, organization, AS/AS name and mobile/proxy/hosting fields. Missing fields are omitted; null and false are preserved. An unknown source update time stays null; retrieval time is not database freshness. Use the independent lookup tool for other fields. Provider classifications do not prove proxy type, reputation or exact location.

**Separate requests can use different exits.** `separate-probe` identifies only what the echo endpoint observed. The same gateway and credentials do not prove the preceding target request used that IP. Gateway hostname/port are input configuration, not the exit IP.

Each valid entry makes at most one target GET, one additional proxy GET when an echo URL is supplied, and one lookup function call when requested and an IP is available. HTTPS CONNECT is separate. Each step has its own `timeoutMs`; three steps can take nearly three times that period. Use `signal` to bound an entire batch. Cancellation prevents subsequent work and retains completed target results. CLI signal cancellation still exits 130.

With IP options, CSV appends `ipSource,exitIp,ipProbeErrorCode,ipLookupErrorCode,country,regionName,city,isp,as,ipLookupStatusCode`; unknown values stay blank. Text beginning with `= + - @` (including leading whitespace) is prefixed with an apostrophe to prevent spreadsheet formula execution. Probe/lookup failures do not change target-based success counts or exit 0/1; inspect their own fields.

### Node.js composition

The library does not load the lookup package automatically. Pass its `lookupIp` function explicitly. Both `ipProbeURL` and `lookupIp` are optional and work with batches. Custom lookup functions must accept the explicit IP plus timeout/byte-limit/signal options and return the lookup package's result shape. Mismatched IPs and invalid fields are rejected.

```js
import { checkProxy } from '@nstdata-ai/proxy-checker';
import { lookupIp } from '@nstdata-ai/ip-lookup';

const proxyURL = process.env.NSTDATA_PROXY_URL;
const ipProbeURL = process.env.NSTDATA_PROXY_IP_ECHO_URL ?? 'https://api.nstdata.io/api/v2/public/utility/client-ip';
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
const result = await checkProxy(proxyURL, {
    targetURL: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
    ipProbeURL,
    lookupIp,
    timeoutMs: 20000,
});
console.log(result);
if (!result.ok) process.exitCode = 1;
```

## Errors

| Code | Meaning / action |
|---|---|
| `IP_LOOKUP_NOT_INSTALLED` | Install the optional lookup package before enabling CLI information lookup; no probe is sent |
| `IP_NOT_OBSERVED` | No usable observed IP; check echo format and status |
| `IP_LOOKUP_FAILED` | Invalid lookup summary, mismatched IP or another unknown lookup error |
| `INVALID_CONFIG` | Check proxy syntax, option ranges, target and CA path/content |
| `INVALID_INPUT_FILE` / `INVALID_INPUT` | CLI file/input cannot be read/parsed; check protected files and JSON |
| `PROXY_AUTHORIZATION_FAILED` | Gateway or CONNECT rejected credentials; check generated connection |
| `PROXY_CONNECT_FAILED` | Gateway rejected CONNECT; check target and channel access |
| `TLS_ERROR` | TLS handshake/chain/hostname verification failed; check CA and complete chain |
| `TIMEOUT` / `CANCELLED` | Local deadline/cancellation; diagnose without unbounded retries |
| `TARGET_HTTP_ERROR` | Complete target response is non-2xx; inspect `statusCode` |
| `CONTENT_MISMATCH` | Valid complete text lacks the literal; check target and expectation |
| `CONTENT_UNAVAILABLE` | Body cannot be reliably assessed, such as invalid UTF-8 or sensitive text |
| `OUTPUT_LIMIT` | Complete 2xx response exceeds assertion cap; match unknown |
| `RESPONSE_LIMIT` | Response headers/download/decoded body exceeded limits, not a pass |
| `INVALID_RESPONSE` / `UNSUPPORTED_RESPONSE` / `UNSUPPORTED_ENCODING` | Invalid proxy response, protocol upgrade or unsupported encoding |
| `UPSTREAM_ERROR` / `CHECK_FAILED` | Other transport/check failure; use a minimal redacted reproduction |

Checks do not replace PM routing verification, data-source verification or real business-scenario acceptance.

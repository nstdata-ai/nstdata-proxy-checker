# Nstdata Proxy Checker

[中文](README_zh.md)

Check HTTP status, request duration and optional content assertions through HTTP/HTTPS proxies, with optional exit-IP probing and location/ISP/ASN summaries. Includes a CLI, Node.js checking library and reusable transport; no required runtime dependencies or Crawl key required.

## Choose a workflow

| Your task | Start here | Result |
|---|---|---|
| Check one proxy | [Quick start](#quick-start) | HTTP status, duration and failure category |
| Check a batch and export CSV | [CLI and batches](docs/guide.md#cli-and-batches) | Ordered rows, counts and exit codes |
| Verify content as well as HTTP health | [Content and results](docs/guide.md#content-and-results) | Literal match or unknown assessment |
| Run checks from Node.js | [Checking library](docs/guide.md#checking-library) | `checkProxy` / `checkProxies` |
| Process proxy responses yourself | [Shared transport](docs/guide.md#shared-transport) | GET/HEAD, response bytes and headers |
| Inspect exit IP and optional location/ASN summary | [Exit information](docs/guide.md#exit-ip-and-information) | Separate target observations, extra probes and lookup results |

## Install

Supports Node.js 22 (22.18 or later) and 24.

> Version 1.1.0 is not yet available on npm. For source installation, see [Contributing](CONTRIBUTING.md).

```sh
npm install @nstdata-ai/proxy-checker@1.1.0
```

## Quick start

Set the generated proxy URL in the protected `NSTDATA_PROXY_URL` environment variable, then run:

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --timeout 20000
```

Output defaults to JSON. `ok: true` means the target returned 2xx; `statusCode` is its HTTP status and `elapsedMs` measures the request through complete body reading/decoding. Inspect `error.code` on failure; see the [result fields](docs/guide.md#content-and-results).

Checks use real proxy traffic. By default, each valid entry makes at most one target GET, including duplicates, without redirects, retries, rotation or direct fallback. A 2xx response does not establish expected content, exit identity or PM routing. Add `--expected-text` to assess content.

`--ip-probe` explicitly adds one IP echo GET; `--ip-info` uses the separately installed `@nstdata-ai/ip-lookup` to query the observed IP. Lookup failure does not change target health, and a rotating proxy can use a different exit for the extra probe.

[Usage guide](docs/guide.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

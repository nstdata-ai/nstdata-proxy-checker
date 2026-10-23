# Contributing

Use Node.js 22.18+ in the 22.x line, or Node.js 24. TLS fixtures require `openssl` on PATH.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:package
```

IP diagnostics add no required runtime dependency; CLI information lookup uses an optional peer, and library callers pass the lookup function explicitly.

The transport uses Node.js built-ins; TypeScript and Node declarations are development dependencies only. Keep proxy URL, destination/header validation, TLS, CONNECT, decoding, byte limits and socket cleanup in the transport implementation. Keep batch scheduling, content assertions and safe CLI output in the checker. Do not add MCP or Crawl dependencies.

Tests use synthetic loopback services and temporary certificates. Cover invalid input before traffic, HTTP/HTTPS gateways, certificate/hostname failures, cancellation, deadlines, authentication isolation, content assertions, batch ordering and CLI exits. Never use live credentials in fixtures.

Package checks verify the allowlist, bilingual commands, public types and both exports, then install the tarball into a separate application with no runtime dependency graph and repeat the loopback tests. They also validate packaged documentation links and execute both bilingual guide programs against a local proxy fixture. Development dependencies must already be cached for offline source installation.

## Local installation

Build the archive after checks pass, then install it from a separate application directory:

```sh
npm pack
```

```sh
npm install /path/to/nstdata-proxy-checker/nstdata-ai-proxy-checker-1.1.0.tgz
```

For CLI information lookup, install a locally built `@nstdata-ai/ip-lookup` archive in that same application. The checker does not fetch or install this optional package at runtime.

```sh
npm install /path/to/nstdata-ip-lookup/nstdata-ai-ip-lookup-1.0.0.tgz
```

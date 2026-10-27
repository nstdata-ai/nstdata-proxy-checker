# Contributing

Use Node.js 22.18+ in the 22.x line, or Node.js 24. TLS fixtures require `openssl` on PATH.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:package
```

IP diagnostics add no required runtime dependency; CLI information lookup uses an optional peer, and library callers pass the lookup function explicitly.

The transport uses Node.js built-ins; TypeScript, Node declarations and Markdown rendering are development dependencies only. Keep proxy URL, destination/header validation, TLS, CONNECT, decoding, byte limits and socket cleanup in the transport implementation. Keep batch scheduling, content assertions and safe CLI output in the checker. Do not add MCP or Crawl dependencies.

Tests use synthetic loopback services and temporary certificates. Cover invalid input before traffic, HTTP/HTTPS gateways, certificate/hostname failures, cancellation, deadlines, authentication isolation, content assertions, batch ordering and CLI exits. Never use live credentials in fixtures.

Package checks verify the allowlist, bilingual commands, public types and both exports, then install the tarball into a separate application with no runtime dependency graph and repeat the loopback tests. They also render public Markdown, validate packaged links and readable code lines, and execute the documented Node.js and CLI commands against local proxy fixtures. Default npm installation is checked against an isolated loopback registry; the optional lookup package uses a synthetic fixture. These checks do not establish public npm availability or live lookup-service behavior. Development dependencies must already be cached for offline source installation.

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

## Releases

The `Publish npm` workflow is started manually from `main`, with a stable version matching `package.json` and the full commit SHA. It checks the source, builds one archive, and records its integrity. The `npm-production` environment reviewer approves publication of that same archive. Successful publication must pass public integrity and default-install checks.

For an existing npm package, configure [trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this repository, `release.yml` and `npm-production`, permitting `npm publish`. The environment must require a reviewer, allow only the `main` branch and disable administrator bypass. No npm token is needed. Configure a new binding near the next release so its first-use deadline is met.

A new package must exist before trusted publishing can be configured. For its first release, the scope owner publishes the reviewed archive using their own npm login and two-factor authentication, following [npm's public scoped-package instructions](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/). Use trusted publishing for subsequent versions. The workflow refuses to bootstrap an unpublished package.

If publication fails or the outcome is uncertain, inspect the registry version and integrity before taking further action. Do not retry publication blindly or change a published version's contents.

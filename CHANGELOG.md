# Changelog

## Unreleased

- Preserve HTTP and application error codes from Nstdata setup failures, with actionable CLI hints.

## 1.2.0

- Add explicit Nstdata CLI mode: obtain one HTTP proxy using an API key and available balance, then check one target.
- Support hidden key input, setup confirmation, explicit env files and country/channel selection.
- Reuse Proxy SDK default-channel handling, cancellation and uncertain-operation safeguards.
- Add the Proxy SDK as a runtime dependency; ordinary checks never call account APIs.
- Preserve the HTTPS target Host header when using a custom CONNECT/TLS connection.

- Explain proxy setup and all command-line options in multiline CLI help.
- Include actionable, redacted messages for invalid CLI configuration and input files.
- Document global CLI installation and test the complete setup sequence from an empty environment.

## 1.1.0

- Provide an independent HTTP/HTTPS proxy checker as a CLI and Node.js library, with no required runtime dependencies.
- Support ordered batches, bounded concurrency, cancellation, literal content assertions and JSON/CSV output.
- Reject invalid UTF-8 proxy files and explicit empty file paths before sending requests; preserve valid Unicode credentials.
- Export a reusable GET/HEAD transport with declarations at `/transport`.
- Verify gateway and target certificates/hostnames, isolate proxy authentication and bound downloaded/decoded responses.
- Refuse redirects, retries and direct fallback; keep target HTTP, authentication, TLS and content failures distinct.
- Preserve completed HTTP status and measured time when content assessment exceeds its output cap; non-2xx takes precedence over the assessment cap.
- Classify incomplete certificate-chain verification failures as TLS errors.
- Accept all successful 2xx CONNECT replies when establishing an HTTPS tunnel.
- Measure duration through complete body decoding; report unknown values explicitly and omit credentials/response bodies from checker results.
- Add explicit exit-IP echo probes and optional IP information lookup, with independent results and bounded cancellation.
- Snapshot per-call options before traffic so later caller mutations cannot enable or redirect diagnostic stages.
- Keep the IP lookup package optional; default checks do not contact its service or install it.
- Include bilingual workflow guides and installed-package, TLS, CLI and executable documentation checks.
- Add manually dispatched npm releases with environment approval, archive integrity and public default-install verification.

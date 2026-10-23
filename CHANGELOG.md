# Changelog

## 1.1.0 — Unreleased

- Provide an independent HTTP/HTTPS proxy checker as a CLI and Node.js library, with no runtime dependencies.
- Support ordered batches, bounded concurrency, cancellation, literal content assertions and JSON/CSV output.
- Export a reusable GET/HEAD transport with declarations at `/transport`.
- Verify gateway and target certificates/hostnames, isolate proxy authentication and bound downloaded/decoded responses.
- Refuse redirects, retries and direct fallback; keep target HTTP, authentication, TLS and content failures distinct.
- Preserve completed HTTP status and measured time when content assessment exceeds its output cap; non-2xx takes precedence over the assessment cap.
- Classify incomplete certificate-chain verification failures as TLS errors.
- Measure duration through complete body decoding; report unknown values explicitly and omit credentials/response bodies from checker results.
- Include bilingual workflow guides and installed-package, TLS, CLI and documentation-example checks.

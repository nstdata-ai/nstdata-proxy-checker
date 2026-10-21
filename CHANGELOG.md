# Changelog

## 1.1.0 — Unreleased

- Replace the internal MCP client/server round trip with a native HTTP/HTTPS transport; remove all runtime dependencies.
- Export the transport at `/transport` and add declarations for both library entries.
- Preserve CLI arguments, result fields, error categories, assertion output cap, batch limits and exit codes.
- Measure elapsed time through body decoding, excluding transport setup and content assessment. Results no longer include MCP call overhead.
- Reject malformed UTF-8 in content assertions instead of matching replacement characters; preserve ordinary HTTP health checks.
- Distinguish gateway/CONNECT authentication failures from an HTTPS target returning 407 inside an established tunnel.
- Keep TLS verification, proxy-only authentication, cancellation, response limits and refusal of redirects/retries/direct fallback.

## 1.0.0 — Local snapshot, unpublished

Initial CLI/library candidate with bounded batches, literal content assertions, JSON/CSV output and a pinned MCP/Crawl dependency graph. Retained local artifacts use that graph; they do not contain the 1.1.0 transport.

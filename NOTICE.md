# Upstream attribution and native changes

This MIT-licensed package contains derived JavaScript from [tjp72/pi-billion-memory](https://github.com/tjp72/pi-billion-memory), version 0.5.3, commit `52e5a01c62df4d40421b93da4528c9e969061c46`. Copyright (c) 2026 tjp72. The upstream MIT notice is retained in [LICENSE](LICENSE).

[extension.js](vendor/extension.js) and [expand.js](vendor/expand.js) were converted from upstream TypeScript and modified for this native port. They are not unmodified upstream artifacts. The native entry is [host.js](src/host.js), not the upstream Pi extension factory retained inside the vendor module.

Material changes include:

- Native Cordis tool/command registration, one plugin-lifetime worker, bounded RPC, cancellation and quiescent shutdown; actual Harness policy authorization for writes.
- Shared Pi 0.5.x schema validation without destructive legacy migration, transactional fresh creation, full-topic redaction before truncation, compare-and-swap source watermarks and cancellation-aware transactions.
- Read-only search/status connections; in-memory diagnostics; no import-time production config access or upstream Pi lifecycle use.
- Config/allowlist fail-closed behavior and Windows path equivalence; file-handle-bound reads and source boundaries.
- Selective streaming projection for billion-context 0.1.166 persisted DSH summaries; exact-ID cwd attribution in a separate transactional sidecar.
- Optional explicitly selected Pi expansion with current allowlist revalidation, caps and cancellation; no DSH raw-message expansion.
- Isolated tests, backup utility and Chinese operational documentation.

No affiliation or endorsement by the upstream authors or DeepSeek is implied. No upstream dependency, Pi installation or current billion-context package is automatically upgraded by this port.

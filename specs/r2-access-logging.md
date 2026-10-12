# Project-owned R2 access logging

Ownership decision, 2026-10-12: jc-taxes owns access logging and collection for its public bucket, including IaC, runtime secrets, retention, billing attribution and deployment. Disky can supply a reusable collector/template; its demo consumes explicitly approved scan/access summaries, not raw request logs.

The Disky reference contract is `~/c/disky/specs/r2-access-logging.md`. It reports native logs enabled, a private collector prepared, and no collector infrastructure apply or scheduled deployment yet. Reconcile its existing stack plan before adopting anything here; do not deploy two collectors.

Implementation requirements:

- Keep raw IPs, actor identifiers and request keys in a separate private archive; never in `jc-taxes`' public tree or public CI logs.
- Own the collector Worker, state store, private archive and lifecycle policy in this project's IaC, with project-specific names and cost attribution.
- Adopt a pinned library/template rather than copying an evolving collector silently. Preserve pagination, overlap, deduplication, sampling and gap semantics.
- Review bounded query windows, schedules and costs before applying resources. Coordinate migration of the pilot secret without printing it.
- Publish only opt-in derived summaries for Disky aggregation. Missing events mean no observed access over a coverage window, not proof an object was never read.

Status: ownership recorded; no logging resources changed or deployed by this project yet.

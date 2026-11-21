# SEO production release

This release changes the public SEO entry and catalog bootstrap. The checkout,
payment, provider integrations, fulfillment handlers and database schema stay
at the protected baseline `d7df5ef63ba99577048baf2ab28512ee4d51c2df`.

## Release procedure

1. Compare the actual active Worker bindings with the private production config.
   Preserve business variables, secret bindings, D1, existing rate limits, domain
   routes and cron. Do not deploy the sanitized example config or run migrations.
2. Build two asset packages with `scripts/preprod/asset-audit.mjs`: old HTML and
   both dependency graphs for rollback; new HTML and both dependency graphs for
   forward deployment. A plain old version lacks candidate chunks; a plain new
   build lacks chunks needed by already-open old pages.
3. Obtain aggregate baseline snapshots using `buildMonitoringQueries`. Start
   `scripts/release/monitor-tail.mjs`, which persists only allowlisted metadata
   and disables Wrangler raw disk logs. Do not save raw callback traffic.
4. Deploy the compatible baseline first using the private prepared config and
   `--keep-vars`. Record its new version ID, compare active configuration, then
   verify both dependency graphs through the production domain.
5. Deploy the candidate with the same preserved configuration and `--keep-vars`.
   The only planned production changes are the storefront entry, Worker-first
   assets, the public SEO origin and an independent SEO catalog limiter.
6. Verify catalog prices and checkout switches against baseline; inspect public
   pages, buyer initialization, order lookup and validation. Exercise the visible
   checkout form without submitting a real order or payment.
7. Observe scheduled work across at least two five-minute reconciliation ticks.
   Compare aggregate payment consistency and fulfillment queues with baseline.
   No real activity means real payment/provider delivery remains unobserved.
8. On a confirmed new failure, immediately roll back to the compatible baseline
   version, then recheck configuration, old/new assets and business endpoints.
   Keep the compatible deployment package for later use; a standard `dist`
   rebuild alone does not retain both generations of assets.

## Evidence handling

Private config backups, artifact manifests, remote version snapshots, aggregate
reports and sanitized tail output belong under ignored `artifacts/`, outside Git.
Never retain customer identifiers, callback signatures or secret values in the
release report. A historical waiting-for-customer order, invalid external callback
or client TLS reset alone is not evidence of a release regression.

Final deployment versions, observed outcomes and remaining limitations are recorded
below after production verification.

# SEO production release

**Current status: rolled back on 2026-11-21 at 15:04:02 UTC (23:04:02
Asia/Shanghai) after the user reported an unacceptable first-paint table.**
The active version is now the verified compatibility version
`c955856c-9141-4f59-9083-2bc6b744f1ef`, deployment
`f8d51e8e-44e1-4748-8951-845cb0dbe552`. The original release below is historical;
its source must not be redeployed without fixing and validating the first paint.

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

## Production deployment, 2026-11-21

| Item | Value |
| --- | --- |
| Source commit | `bc68dd48b27569e7d9ac30450cbeff32465a03c4` |
| Release tag | `release-2026-11-21-seo-foundation` |
| Candidate Worker version (now rolled back) | `b6c4145f-f0de-4caa-a079-0ce09eec6669` |
| Activated | 2026-11-21 14:47:18 UTC / 22:47:18 Asia/Shanghai |
| Compatible rollback version | `c955856c-9141-4f59-9083-2bc6b744f1ef` |
| Rollback source | `d7df5ef63ba99577048baf2ab28512ee4d51c2df`, with both asset generations |
| Rollback tag | `release-2026-11-21-seo-rollback` |

The compatible baseline was first deployed and verified through the production
domain. Its 21 dependencies all passed status, MIME, byte-count and SHA checks.
The candidate retains those same old/new dependencies. One candidate font fetch
failed at the transport layer; its isolated retry returned the expected 200,
font MIME, size and SHA. The original failed observation is retained.

Both active deployments preserved all 55 existing bindings, including 27 business
variables and 23 secret bindings, plus the D1 resource, domain, cron, original
limiters and security headers. Secret values are not readable via the API;
Wrangler's secret-preservation behavior and unchanged binding names were checked.
No migrations or production configuration/data resets were performed.

The configured-entry regression suite passed 727 tests; scope verification
preserved 814 protected files and the transaction-related App/useStore ASTs.
Lint and public-source scan passed. The source job in CI run `44915397573` passed;
the separate Go backend job retains the pre-existing failures already reproduced
and documented during the isolated rehearsal. It is not reported as green.

Production HTTP checks passed 14 checks on the compatible baseline and 17 on the
candidate: live catalog prices and checkout switches, page and script responses,
buyer initialization, empty order list, configured Turnstile/recovery and rejection
of an empty order without creation. The first baseline comparison falsely treated
an undefined optional field as different from its JSON-omitted representation;
the corrected comparison passed and both observations were retained.

Visible browser checks passed for an already-open old page, fresh ChatGPT Pro
10x selection and purchase form, Codex 500 points selection and form, automatic
account-delivery form, and the email order-recovery dialog. Forms showed the
expected 1350, 199 and 85 amounts. No real order, payment, CAPTCHA solution,
customer credential entry or email verification message was submitted.

The candidate's 14:50:29 and 14:55:29 UTC five-minute reconciliation invocations
both completed with `outcome=ok` and no queue failures, also confirmed by an
independent reviewer. Observation continued through 14:57:43 UTC (10 minutes
25 seconds after activation): 334 candidate events and 11 scheduled invocations
contained no 5xx, exceptions, resource-limit outcomes or queue failures.
The 14:56:05 UTC aggregate snapshot found no payment/order mismatch, no pending
recharge notification verification, no supplier procurement or delivery backlog,
and no change to the pre-existing waiting-for-customer order. It contained one
`payment-closed` / `cancelled` transition, confirmed by a separate aggregate query
to belong to a pre-release unpaid order, and no new orders or payment receipts.

One homepage GET had a `canceled` outcome without a response status or exception.
Its cause is unknown. The initial broad non-OK-event gate flagged it; it was
retained separately from server errors, and subsequent homepage/catalog probes
both returned 200 with SEO content and checkout enabled. No evidence connected
this canceled request to a checkout or fulfillment failure.

No new paid order, payment notification, verified provider webhook or completed
recharge attempt occurred in the observation window. This validates configuration,
entry points and scheduled execution, but does **not** claim a fresh real-payment
or third-party fulfillment success. No confirmed release regression triggered a
rollback. Tail observation ended after the bounded post-release checks; it is not
an unattended ongoing monitor or an automatic rollback service.

## User-reported first-paint regression and rollback

The public renderer injected a separate product table into `#root`. The unchanged
React entry used `createRoot().render()`, replacing that table only after the
client bundle ran. Consequently the table was visible to ordinary JavaScript
users too; slow loading extends that interval, and a failed script can leave it
visible. The user screenshot demonstrates this presentation, but does not by
itself establish how long it remained visible on that device.

The original 727-test suite and HTTP checks covered document content, routing
and transaction preservation. Browser acceptance checked the final interactive
state, not first-paint appearance with delayed or failed scripts. Those checks
were insufficient for approving this rendering change. The previous description
of the table as a no-JavaScript view was incomplete.

The user had already authorized immediate rollback on regressions. The rollback
restored the compatibility version to 100% traffic; a subsequent active-version
audit preserved all 55 original bindings, and all 14 baseline HTTP checks and
21 old/new static dependencies passed. The database was not restored or reset.
The raw evidence is retained in the main project's ignored
`artifacts/incidents/2026-11-21-seo-first-paint/` directory.

The separate homepage design branch `codex/homepage-guidance` at `0e1b96f` was
never included in the SEO candidate, which was based directly on `d7df5ef`.
Thus the prior homepage design work was not deployed, and this release should
not have been communicated as delivering that visual redesign.

Before another release, remove the mismatching table from the storefront's
initial render or implement initial markup consistent with the actual storefront.
Do not merely switch to `hydrateRoot` over incompatible markup, hide content from
people while showing it to crawlers, or treat final-state screenshots as first-paint
coverage. Validate delayed/failed script loading and desktop/mobile rendering.
No corrected SEO candidate was deployed as part of this incident response.

## Durable private archive and future operations

The main checkout stays on its independent homepage branch. Its original private
`wrangler.production.jsonc` stays byte-identical and is not the SEO deployment
configuration. This avoids silently changing the configuration of another branch.

The durable local archive is `artifacts/releases/2026-11-21-seo-bc68dd48/` beneath
the main project root. It contains both dist directories, full hashed manifests,
private config snapshots and verification evidence. Historical configs containing
temporary source paths are marked `*.evidence-only.json`; do not deploy them.

The archive's `rollback-only.json` has only the Worker name and account identity.
Cloudflare rollback uses the stored cloud version and does not require a local
main file, temporary checkout or asset directory. Run from the main project root:

```sh
node_modules/.bin/wrangler rollback c955856c-9141-4f59-9083-2bc6b744f1ef \
  --config artifacts/releases/2026-11-21-seo-bc68dd48/rollback-only.json \
  --yes --message 'Restore compatible pre-SEO release'
```

Before a future rollback, check that no newer release has superseded this one.
After rollback, verify the active version, preserved settings, both dependency
graphs and business endpoints. A later redeployment requires the recorded source
commit, corresponding archived assets and a fresh audit of production settings.
Do not redeploy from the unrelated homepage branch or from an ordinary single
generation `dist` directory.

# noticepro-app

Edit the Countdown in [`storefront-src/countdown.js`](./storefront-src/countdown.js),
not in the generated extension asset. Run `npm run countdown:generate` to
regenerate `extensions/notice-pro-storefront/assets/countdown.js`, or
`npm run countdown:check` to verify that the checked-in asset is fresh and
within Shopify's 10,000-byte limit. `npm test` includes this freshness check.

The Dispatch notice kind uses the additive
`20261123190000_add_notice_kind` Prisma migration. A generated Prisma Client
expects this field, so the migration must be applied to the PostgreSQL database
before deploying/running this version against it. The migration is prepared
but has not been applied in this workspace.

## Country targeting release readiness

**DO NOT RELEASE country-selected widgets yet.** XFF-based resolution remains
disabled. A Cloudflare Worker attestation path is implemented locally but is
disabled by default and has not been deployed or tested against a hosted
storefront. Until the Worker and app configuration pass hosted acceptance,
country resolution is unknown: `SELECTED` widgets fail closed and can be
hidden, while `ALL` remains unaffected.

The browser obtains a short-lived app-issued challenge, calls a dedicated
Worker directly, and relays the signed assertion in the POST body to each
widget proxy route. The Worker reads only its incoming `request.cf.country`;
the app verifies the signature, challenge, shop, expiry, and supported code.
No client country/IP override, IP storage, or IP logging is added. Reusable
assertions allow Announcement, Notice/Dispatch, and Countdown to share a
resolution, but can be relayed or replayed until expiry; this is messaging
personalization, not fraud prevention.

The legacy GeoLite reader/manager remains in the codebase but must stay
disabled with `NOTICEPRO_GEOIP_ENABLED` unset or set to anything other than
exact `true`. Worker secrets are private runtime settings and are never
included in browser assets. The country-targeting migration is prepared but
has not been applied. Offline tests use synthetic challenges and mocked
Cloudflare `request.cf` values; they are not genuine Worker, hosted, or browser
evidence. The Worker package and Free-plan setup are in
[`country-attestation-worker/README.md`](./country-attestation-worker/README.md).

The editor warns that selected targeting remains unavailable until the Worker
is deployed, configured, and validated. The legacy GeoLite reader/manager and
its license notices remain in the repository, but the Worker path does not use
GeoLite data or require MaxMind credentials. See the [country-targeting
release/runbook](./COUNTRY-TARGETING-RUNBOOK.md) for private configuration,
migration prerequisites, hosted acceptance gates, and rollback policy. No
Shopify app configuration or database migration was changed or executed for
the Worker integration.

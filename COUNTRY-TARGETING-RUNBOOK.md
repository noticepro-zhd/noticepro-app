# Country-targeting release runbook

## Status: prepared locally, not enabled or released

**DO NOT RELEASE or enable country-selected widgets yet.** The XFF-based
visitor-IP path remains unused. A Cloudflare Worker country-attestation path
is implemented locally, but no Worker has been deployed and no hosted or real
browser acceptance has occurred. The feature is disabled unless private
runtime configuration explicitly enables it. With no valid attestation,
`SELECTED` widgets fail closed and may be hidden; `ALL` widgets remain
unaffected.

The existing country-targeting migration is prepared but not applied. No
application database access, migration execution, provider download, account
setup, hosted deployment, Shopify release, commit, or push occurred here.

## What is implemented and what local tests establish

- Announcement, Notice/Dispatch, and Countdown persist `ALL` or one/multiple
  supported ISO alpha-2 countries. Existing page/schedule targeting runs
  before country matching and display caps; public response shapes and
  billing limits are preserved.
- An authenticated App Proxy route issues a short-lived challenge bound to
  `session.shop`. Storefront code calls the Worker directly; it reads country
  only from its incoming `request.cf.country`, signs an assertion, and does
  not use client headers, query overrides, cookies, or stored state.
- The challenge and assertion are sent in the POST body to all three App Proxy
  routes. Render verifies both signatures, shop, nonce, expiry, and the
  supported country dataset. One in-memory browser promise shares the same
  assertion among all three widgets. Tokens are stateless and reusable until
  expiry so they can be shared; a token can be relayed or replayed during its
  short lifetime. This is personalization, not fraud prevention, identity
  proof, or access control.
- CORS allows non-credentialed storefront calls. CORS and `Origin` are not
  authentication; signed challenges are. A valid challenge can be relayed by
  its holder. No IP value is returned, retained, or logged by app/Worker code.
  Cloudflare still processes the network request as the hosting provider.
- Offline tests use synthetic HMAC secrets, challenge payloads, and mocked
  `request.cf` values. They prove code paths, not Cloudflare edge behavior,
  a live store's country result, or browser acceptance. The legacy GeoLite
  reader tests use MaxMind's synthetic MMDB fixture and do not test a real
  GeoLite database. No real production database has been read.
- `COUNTDOWN` continues to use `storefront-src/countdown.js` as its canonical
  source; the generated extension asset remains subject to the 10,000-byte
  check.
- Shopify app configuration and database schema were not changed for this
  Worker integration. Storefront extension JavaScript assets did change and
  require the normal approved app/extension release workflow to reach stores.

## Runtime configuration

These are server-side settings only. Do not place the signing secret in
Shopify configuration, source files, command arguments, browser assets, or
logs.

| Setting | Supported value and behavior |
| --- | --- |
| `NOTICEPRO_COUNTRY_ATTESTATION_ENABLED` | Exact string `true` enables challenge issuance and verification; unset or any other value disables the integration. |
| `NOTICEPRO_COUNTRY_ATTESTATION_SECRET` | Shared private HMAC secret, 32–512 printable ASCII characters. Set the same random value as a Render private secret and a Cloudflare Worker secret. |
| `NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL` | HTTPS URL with path exactly `/attest`; no credentials, query, or fragment. This is public configuration returned to storefront code after App Proxy authentication. |
| `NOTICEPRO_GEOIP_ENABLED` | Keep unset or anything other than exact `true`; the legacy GeoLite lifecycle must remain disabled. |

`MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` are not required for
attestation and must not be added for this integration. The GeoLite manager
remains in the repository but is no longer the country resolver and must stay
disabled.

## Worker package setup

Follow [`country-attestation-worker/README.md`](./country-attestation-worker/README.md)
to deploy `country-attestation-worker/` to an existing Cloudflare Workers Free
account using its `workers.dev` subdomain. It gives the Wrangler commands and
private-secret steps. The Worker has no database/KV bindings and disables
Workers observability logs in its Wrangler configuration. Confirm current
[Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
and the [`workers.dev` service description](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
before relying on that hosting choice.

The challenge is valid for up to 180 seconds and a country assertion for up to
120 seconds. App request bodies are bounded to 4 KiB and Worker challenge
bodies to 2 KiB. No token-use database, timer, IP cache, or import-time
network operation is added.

## Legacy GeoLite code and licenses

The Worker integration does not use GeoLite data and requires no MaxMind
credentials. The existing GeoLite reader, lifecycle, package, synthetic test
fixture, and license notices are retained but are not the active country
resolver; keep `NOTICEPRO_GEOIP_ENABLED` disabled. If GeoLite use is
reintroduced later, review the then-current attribution and usage terms for
that use. Published MaxMind guidance is not legal certification of a specific
storefront use, and no blanket permission request is implied. References:

- [GeoLite use and attribution](https://support.maxmind.com/knowledge-base/articles/sell-or-display-data-from-geolite-databases-and-web-services)
- [GeoLite download and retention terms](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/)
- [MaxMind database updates](https://dev.maxmind.com/geoip/updating-databases/)
- [MaxMind official synthetic MMDB test data](https://github.com/maxmind/MaxMind-DB/tree/main/test-data)
- [Shopify App Proxy authentication and forwarded POST body behavior](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies)
- [Cloudflare `request.cf.country`](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers observability logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

The retained `maxmind@5.1.0` reader is MIT-licensed; its `mmdb-lib@3.0.3`
dependency is MIT and `tiny-lru@13.1.1` is BSD-3-Clause. The synthetic MMDB
fixture is from the official MaxMind test-data repository; its included MIT
notice is `tests/fixtures/MAXMIND-DB-LICENSE-MIT.txt`. Country data is derived
from `i18n-iso-countries@7.14.0` under MIT, with notice at
`app/features/widgets/COUNTRY-DATA-LICENSE.txt`.

## Migration and deployment prerequisites — not executed

The additive migration is
`prisma/migrations/20261123200000_add_widget_country_targeting/migration.sql`:

```sql
ALTER TABLE "Widget"
ADD COLUMN "countryTargetingMode" TEXT NOT NULL DEFAULT 'ALL',
ADD COLUMN "targetCountryCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
```

Before deploying the app, verify the intended Render service and database
identity through approved private operator tooling, take a restricted private
PostgreSQL backup, and verify it can be listed/restored in an isolated target.
Review all pending migrations, including the existing Dispatch migration.
Do not put database URLs or credentials in command arguments, logs, or this
runbook. The repository's Docker startup uses `npm run docker-start`, which
runs `npm run setup` and `prisma migrate deploy`; deployment can therefore
apply pending migrations. Do not deploy until the migration state, backup,
and target are approved.

## One operator setup and release checklist

1. **Review the full release diff and schema first.** Preserve the existing
   app identity, Render service/URLs, database settings, Shopify app
   configuration, and old resources. Verify migration status and backup
   prerequisites above. Keep `NOTICEPRO_GEOIP_ENABLED` off.
2. **Deploy the Worker** from its package README using the existing Cloudflare
   Free account, `workers.dev`, and a newly generated private HMAC secret.
   Record only the public `/attest` Worker URL in private deployment
   configuration; never put the signing secret in the repository or chat.
3. **Configure the existing Render service privately** with
   `NOTICEPRO_COUNTRY_ATTESTATION_SECRET` and
   `NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL`. Keep
   `NOTICEPRO_COUNTRY_ATTESTATION_ENABLED` unset or not equal to `true` until
   the application version is deployed and the preflight checks pass.
4. **Deploy the application and extension update** only through the reviewed
   existing workflows. Preserve app identity, URLs, credentials, database
   settings, build/start commands, and Shopify app configuration. Confirm
   which pending migrations the deployment will apply before release. Leave
   attestation disabled; this deployment alone must not trigger Worker calls.
5. **Verify hosted failure and auth paths:** unsigned direct-origin
   challenge/widget requests are rejected; normal authenticated App Proxy
   requests still return the existing envelopes; disabled/missing Worker
   configuration leaves `ALL` working and hides only `SELECTED`. Check
   that access logs do not capture request bodies or signed query URLs before
   testing. Do not inspect or copy raw IPs from logs.
6. **Run controlled enabled acceptance** by temporarily setting the exact
   enable value only after confirming no non-test shop has selected-country
   widgets, or after arranging an isolated app environment. Verify Worker
   CORS from a storefront and confirm client country headers/query values do
   not change the result. Test all three widget types with `ALL`; one and
   multiple selected countries; matching and
   nonmatching storefront locations; unknown/unavailable country; page and
   schedule combinations; display caps and Free/Pro gates; saved edits;
   failed saves; successful save/reset; Cancel and toast cleanup. Verify no
   country targeting data or tokens enter public widget responses. Label
   synthetic tests separately from live results. Disable attestation after
   the test until release approval.
7. **Only after all checks pass and release is approved**, set
   `NOTICEPRO_COUNTRY_ATTESTATION_ENABLED=true` as a private Render setting.
   If a reliable live location result cannot be established, leave it off and
   do not release selected targeting. No live acceptance has been performed
   by this local task.

## Rollback/disable

Set `NOTICEPRO_COUNTRY_ATTESTATION_ENABLED` to anything other than exact
`true` or remove it. The challenge route returns unavailable, browser calls
fall back to the original GET requests, `ALL` remains available, and
`SELECTED` fails closed. Keep the migration and selected-country data; do not
perform a destructive schema rollback. The Worker may remain deployed or be
disabled through the normal reviewed Cloudflare workflow.

# NoticePro country-attestation Worker

This Worker issues short-lived, signed country assertions for messaging
personalization. It reads country only from Cloudflare's incoming
`request.cf.country`; it does not read client IP/country headers, query
parameters, cookies, or stored state. There is no IP logging or storage in
this Worker. Cloudflare still processes the network request as the hosting
provider.

The app's `/api/proxy/country-challenge` route issues a shop-bound, signed
challenge only after Shopify App Proxy authentication. The browser sends that
challenge directly to this Worker, then relays the returned assertion and
challenge in the POST body of the Announcement, Notice/Dispatch, and Countdown
App Proxy requests. The app verifies the Worker signature, challenge, shop,
expiry, and supported country code. These assertions are reusable until their
short expiry so the three widgets can share one resolution; a bearer token can
be relayed or replayed during that window. This is personalization only, not
fraud prevention or a security boundary.

## Existing-account Free-plan setup

Use an existing Cloudflare account with the Workers Free plan and its
`workers.dev` subdomain. No custom domain, Worker route, database, KV, or other
paid resource is required by this package. The Free plan has platform quotas;
check the current [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
before relying on it for a live store. Cloudflare describes `workers.dev` as
intended for personal or hobby projects, so confirm that it meets the intended
service requirements before release.

1. From this directory, authenticate Wrangler to the existing account if it
   is not already authenticated:

   ```sh
   npx wrangler login
   ```

2. Deploy the Worker once from this directory to create it. Until its secret
   is configured, it returns unavailable and the app must remain disabled:

   ```sh
   npx wrangler deploy
   ```

   Wrangler reports the public `workers.dev` URL. The app endpoint must be its
   HTTPS URL with the `/attest` path; the URL is public configuration, not a
   secret.

3. Generate a new random secret privately on the operator's machine. Do not
   put it in this repository, chat, shell command arguments, or logs. Set the
   same value in the Worker secret and the Render service's private
   environment settings:

   ```sh
   openssl rand -hex 32
   npx wrangler secret put NOTICEPRO_COUNTRY_ATTESTATION_SECRET
   ```

   Wrangler prompts for the value; `secret put` creates and immediately
   deploys a new Worker version. Do not use a Wrangler `vars` entry for this
   secret.

4. Configure the existing Render service using only private server-side
   environment settings. Do not put these in Shopify configuration or browser
   assets:

   | Setting | Value |
   | --- | --- |
   | `NOTICEPRO_COUNTRY_ATTESTATION_ENABLED` | Exact string `true` to enable; unset or any other value disables the integration. |
   | `NOTICEPRO_COUNTRY_ATTESTATION_SECRET` | The same random value set with Wrangler; private secret. |
   | `NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL` | Worker HTTPS URL ending in exactly `/attest`; public URL, no query or fragment. |
   | `NOTICEPRO_GEOIP_ENABLED` | Exact string `false`; keep the legacy GeoLite manager disabled. |

5. Redeploy the existing app service only after reviewing the complete
   country-targeting release gates in the root [country-targeting runbook](../COUNTRY-TARGETING-RUNBOOK.md).
   Verify Worker direct-origin/CORS behavior, normal app-proxy calls,
   selected-country matching and unknown-country fallback before enabling
   country selections for merchants.

The Worker has no data bindings and no observability logs enabled in
`wrangler.toml`. CORS uses `Access-Control-Allow-Origin: *` without
credentials so storefronts can call the Worker directly. CORS is not
authentication: the signed challenge is the authorization mechanism.

## Official platform references

- [`request.cf.country`](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- [Workers Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers `workers.dev` URLs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers observability logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Wrangler deployment commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

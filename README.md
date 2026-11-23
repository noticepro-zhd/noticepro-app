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

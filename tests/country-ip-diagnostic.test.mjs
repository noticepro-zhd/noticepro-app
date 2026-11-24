import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import {
  createCountryIpDiagnosticRateLimiter,
  inspectForwardedFor,
  readCountryIpDiagnosticConfig,
} from "../app/features/widgets/country-ip-diagnostic.server.ts";

const validShop = "operator-test.myshopify.com";

function activeEnvironment(now = Date.now()) {
  return {
    NOTICEPRO_IP_DIAGNOSTICS_ENABLED: "true",
    NOTICEPRO_IP_DIAGNOSTICS_SHOP: validShop,
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_COUNTRY: "US",
    NOTICEPRO_IP_DIAGNOSTICS_STARTS_AT: new Date(now - 60_000).toISOString(),
    NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT: new Date(now + 10 * 60_000).toISOString(),
  };
}

function loadDiagnosticRoute({
  env,
  authenticate,
  lookupCountryForIp,
  geoLiteReady = true,
}) {
  const source = fs.readFileSync(
    new URL("../app/routes/api.proxy.ip-diagnostic.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    process: { env },
    Date,
    Response,
    Headers,
    URL,
    setTimeout,
    clearTimeout,
    console,
  });
  const mocks = {
    "../shopify.server": { authenticate },
    "../features/widgets/country-database.server": {
      isCountryDatabaseReady: () => geoLiteReady,
      lookupCountryForIp,
    },
    "../features/widgets/country-ip-diagnostic.server": {
      createCountryIpDiagnosticRateLimiter,
      inspectForwardedFor,
      readCountryIpDiagnosticConfig: () =>
        readCountryIpDiagnosticConfig(env),
    },
  };
  const wrapper = vm.runInContext(
    `(function (exports, require, module) {${output}\n})`,
    context,
  );
  wrapper(module.exports, (specifier) => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import: ${specifier}`);
  }, module);
  return module.exports.loader;
}

test("diagnostic configuration is disabled by default and bounded to 30 minutes", () => {
  const now = Date.now();
  assert.equal(readCountryIpDiagnosticConfig({}, now), null);
  assert.equal(
    readCountryIpDiagnosticConfig(
      { ...activeEnvironment(now), NOTICEPRO_IP_DIAGNOSTICS_ENABLED: "TRUE" },
      now,
    ),
    null,
  );

  const tooLong = activeEnvironment(now);
  tooLong.NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT = new Date(
    now + 31 * 60_000,
  ).toISOString();
  assert.equal(readCountryIpDiagnosticConfig(tooLong, now), null);

  const future = activeEnvironment(now);
  future.NOTICEPRO_IP_DIAGNOSTICS_STARTS_AT = new Date(
    now + 1,
  ).toISOString();
  assert.equal(readCountryIpDiagnosticConfig(future, now), null);

  const expired = activeEnvironment(now);
  expired.NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT = new Date(
    now,
  ).toISOString();
  assert.equal(readCountryIpDiagnosticConfig(expired, now), null);

  assert.deepEqual(readCountryIpDiagnosticConfig(activeEnvironment(now), now), {
    shop: validShop,
    expectedCountry: "US",
    startsAt: now - 60_000,
    expiresAt: now + 10 * 60_000,
  });
});

test("diagnostic rejects invalid shops and unsupported expected countries", () => {
  const now = Date.now();
  const invalidShop = activeEnvironment(now);
  invalidShop.NOTICEPRO_IP_DIAGNOSTICS_SHOP = "attacker.example";
  assert.equal(readCountryIpDiagnosticConfig(invalidShop, now), null);

  const invalidCountry = activeEnvironment(now);
  invalidCountry.NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_COUNTRY = "ZZ";
  assert.equal(readCountryIpDiagnosticConfig(invalidCountry, now), null);
});

test("forwarded-for inspection reports only bounded sanitized verdicts", async () => {
  const rawIps = [
    "203.0.113.45",
    "2001:db8:abcd::1",
    "192.0.2.123",
    "2001:db8::123",
    "not-an-address",
    "198.51.100.8",
  ];
  const lookups = [];
  const result = await inspectForwardedFor(
    rawIps.join(", "),
    "US",
    async (ip) => {
      lookups.push(ip);
      if (ip === "203.0.113.45") return "US";
      if (ip === "2001:db8:abcd::1") return "CA";
      return null;
    },
  );

  assert.deepEqual(
    result.entries.map(({ position, addressFamily, verdict }) => ({
      position,
      addressFamily,
      verdict,
    })),
    [
      { position: 0, addressFamily: "ipv4", verdict: "expected-country" },
      { position: 1, addressFamily: "ipv6", verdict: "other-country" },
      { position: 2, addressFamily: "ipv4", verdict: "synthetic-ipv4" },
      { position: 3, addressFamily: "ipv6", verdict: "synthetic-ipv6" },
      { position: 4, addressFamily: null, verdict: "malformed" },
      { position: 5, addressFamily: "ipv4", verdict: "unknown-country" },
    ],
  );
  assert.equal(result.entryCount, 6);
  assert.deepEqual(lookups, [
    "203.0.113.45",
    "2001:db8:abcd::1",
    "198.51.100.8",
  ]);
  assert.equal(JSON.stringify(result).includes(rawIps[0]), false);
  assert.equal(JSON.stringify(result).includes(rawIps[1]), false);
});

test("forwarded-for inspection rejects oversized values and bounds entry work", async () => {
  let lookups = 0;
  const oversized = await inspectForwardedFor(
    "1".repeat(4097),
    "US",
    async () => {
      lookups += 1;
      return "US";
    },
  );
  assert.equal(oversized.tooLarge, true);
  assert.equal(oversized.inspectedCount, 0);
  assert.equal(lookups, 0);

  const manyEntries = Array.from({ length: 20 }, () => "203.0.113.1").join(",");
  const bounded = await inspectForwardedFor(manyEntries, "US", async () => {
    lookups += 1;
    return "US";
  });
  assert.equal(bounded.entryCount, 20);
  assert.equal(bounded.inspectedCount, 16);
  assert.equal(bounded.omittedCount, 4);
  assert.equal(lookups, 16);
});

test("forwarded-for lookup failures produce only a sanitized explicit verdict", async () => {
  const result = await inspectForwardedFor(
    "203.0.113.45",
    "US",
    async () => {
      throw new Error("lookup failed for 203.0.113.45");
    },
  );

  assert.deepEqual(result.entries, [
    { position: 0, addressFamily: "ipv4", verdict: "lookup-error" },
  ]);
  assert.equal(JSON.stringify(result).includes("203.0.113.45"), false);
});

test("diagnostic rate limiter permits six requests per shop in each minute", () => {
  let now = 1000;
  const limiter = createCountryIpDiagnosticRateLimiter({ now: () => now });
  for (let count = 0; count < 6; count += 1) {
    assert.equal(limiter.allow(validShop), true);
  }
  assert.equal(limiter.allow(validShop), false);
  now += 60_000;
  assert.equal(limiter.allow(validShop), true);
});

test("diagnostic route requires app-proxy auth, exact test shop, and returns no IP or signature", async () => {
  const env = activeEnvironment();
  let lookups = 0;
  const lookupCountryForIp = async () => {
    lookups += 1;
    return "US";
  };
  const request = new Request(
    "https://noticepro-app.onrender.com/api/proxy/ip-diagnostic?shop=operator-test.myshopify.com&signature=private-signature",
    { headers: { "X-Forwarded-For": "203.0.113.45, 192.0.2.123" } },
  );

  const unauthenticated = loadDiagnosticRoute({
    env,
    authenticate: {
      public: {
        appProxy: async () => {
          throw new Response(null, { status: 401 });
        },
      },
    },
    lookupCountryForIp,
  });
  await assert.rejects(unauthenticated({ request }), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(lookups, 0);

  const loader = loadDiagnosticRoute({
    env,
    authenticate: {
      public: {
        appProxy: async () => ({
          session: { shop: validShop },
        }),
      },
    },
    lookupCountryForIp,
  });
  const response = await loader({ request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const responseBody = await response.text();
  for (const value of [
    "203.0.113.45",
    "192.0.2.123",
    "private-signature",
  ]) {
    assert.equal(responseBody.includes(value), false);
  }
  assert.deepEqual(JSON.parse(responseBody), {
    headerTrust: "unverified",
    geoLiteReady: true,
    forwardedFor: {
      present: true,
      tooLarge: false,
      entryCount: 2,
      inspectedCount: 2,
      omittedCount: 0,
      entries: [
        {
          position: 0,
          addressFamily: "ipv4",
          verdict: "expected-country",
        },
        {
          position: 1,
          addressFamily: "ipv4",
          verdict: "synthetic-ipv4",
        },
      ],
    },
  });
  assert.equal(lookups, 1);
});

test("diagnostic reports reader-not-ready and does not invent a country", async () => {
  const loader = loadDiagnosticRoute({
    env: activeEnvironment(),
    authenticate: {
      public: {
        appProxy: async () => ({ session: { shop: validShop } }),
      },
    },
    lookupCountryForIp: async () => null,
    geoLiteReady: false,
  });
  const response = await loader({
    request: new Request("https://noticepro-app.onrender.com/api/proxy/ip-diagnostic", {
      headers: { "X-Forwarded-For": "203.0.113.45" },
    }),
  });
  const body = await response.json();
  assert.equal(body.geoLiteReady, false);
  assert.equal(body.forwardedFor.entries[0].verdict, "unknown-country");
});

test("diagnostic route conceals disabled and non-operator shops and rate-limits", async () => {
  const env = activeEnvironment();
  const authenticate = {
    public: {
      appProxy: async () => ({ session: { shop: validShop } }),
    },
  };
  const lookupCountryForIp = async () => "US";

  const disabledLoader = loadDiagnosticRoute({
    env: {},
    authenticate,
    lookupCountryForIp,
  });
  const request = new Request("https://noticepro-app.onrender.com/api/proxy/ip-diagnostic");
  assert.equal((await disabledLoader({ request })).status, 404);

  const loader = loadDiagnosticRoute({
    env,
    authenticate: {
      public: {
        appProxy: async () => ({
          session: { shop: "another-test.myshopify.com" },
        }),
      },
    },
    lookupCountryForIp,
  });
  assert.equal((await loader({ request })).status, 404);

  const rateLimitedLoader = loadDiagnosticRoute({
    env: activeEnvironment(),
    authenticate,
    lookupCountryForIp,
  });
  for (let count = 0; count < 6; count += 1) {
    assert.equal((await rateLimitedLoader({ request })).status, 200);
  }
  assert.equal((await rateLimitedLoader({ request })).status, 429);
});

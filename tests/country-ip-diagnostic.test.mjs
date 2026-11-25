import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import {
  createCountryIpDiagnosticRateLimiter,
  inspectForwardedFor,
  isOperatorDiagnosticShop,
  readCountryIpDiagnosticConfig,
} from "../app/features/widgets/country-ip-diagnostic.server.ts";

const operatorShop = "zahidsapp.myshopify.com";

function activeEnvironment(now = Date.now()) {
  return {
    NOTICEPRO_IP_DIAGNOSTICS_ENABLED: "true",
    NOTICEPRO_IP_DIAGNOSTICS_STARTS_AT: new Date(now - 60_000).toISOString(),
    NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT: new Date(now + 10 * 60_000).toISOString(),
  };
}

function expectedAddressConfig(overrides = {}) {
  const config = readCountryIpDiagnosticConfig({
    ...activeEnvironment(),
    ...overrides,
  });
  assert.ok(config);
  return config.expectedAddressConfig;
}

function loadDiagnosticRoute({ env, authenticate }) {
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
  });
  const mocks = {
    "../shopify.server": { authenticate },
    "../features/widgets/country-ip-diagnostic.server": {
      createCountryIpDiagnosticRateLimiter,
      inspectForwardedFor,
      isOperatorDiagnosticShop,
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

test("diagnostic is disabled by default and requires an active window of at most 30 minutes", () => {
  const now = Date.now();
  assert.equal(readCountryIpDiagnosticConfig({}, now), null);
  assert.equal(
    readCountryIpDiagnosticConfig(
      {
        ...activeEnvironment(now),
        NOTICEPRO_IP_DIAGNOSTICS_ENABLED: "TRUE",
      },
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
  expired.NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT = new Date(now).toISOString();
  assert.equal(readCountryIpDiagnosticConfig(expired, now), null);

  const validConfig = readCountryIpDiagnosticConfig(activeEnvironment(now), now);
  assert.deepEqual(
    { startsAt: validConfig.startsAt, expiresAt: validConfig.expiresAt },
    { startsAt: now - 60_000, expiresAt: now + 10 * 60_000 },
  );
  assert.deepEqual(
    {
      present: validConfig.expectedAddressConfig.present,
      valid: validConfig.expectedAddressConfig.valid,
    },
    { present: false, valid: false },
  );
});

test("only the exact operator shop is eligible", () => {
  assert.equal(isOperatorDiagnosticShop("zahidsapp.myshopify.com"), true);
  assert.equal(isOperatorDiagnosticShop("ZAHIDSAPP.MYSHOPIFY.COM"), true);
  assert.equal(isOperatorDiagnosticShop("other.myshopify.com"), false);
  assert.equal(isOperatorDiagnosticShop("zahidsapp.myshopify.com.attacker.test"), false);
});

test("header inspection reports bounded shape and synthetic markers without returning IP values", () => {
  const rawValues = [
    "203.0.113.45",
    "2001:db8:abcd::1",
    "192.0.2.123",
    "2001:db8::123",
    "not-an-address",
  ];
  const result = inspectForwardedFor(
    rawValues.join(", "),
    expectedAddressConfig(),
  );

  assert.deepEqual(
    result.entries.map(
      ({ position, addressFamily, verdict, matchesExpectedAddress }) => ({
        position,
        addressFamily,
        verdict,
        matchesExpectedAddress,
      }),
    ),
    [
      {
        position: 0,
        addressFamily: "ipv4",
        verdict: "non-public",
        matchesExpectedAddress: false,
      },
      {
        position: 1,
        addressFamily: "ipv6",
        verdict: "non-public",
        matchesExpectedAddress: false,
      },
      {
        position: 2,
        addressFamily: "ipv4",
        verdict: "synthetic-ipv4",
        matchesExpectedAddress: false,
      },
      {
        position: 3,
        addressFamily: "ipv6",
        verdict: "synthetic-ipv6",
        matchesExpectedAddress: false,
      },
      {
        position: 4,
        addressFamily: null,
        verdict: "malformed",
        matchesExpectedAddress: false,
      },
    ],
  );
  assert.equal(result.entryCount, 5);
  const serialized = JSON.stringify(result);
  for (const value of rawValues.slice(0, 4)) {
    assert.equal(serialized.includes(value), false);
  }
});

test("header inspection bounds length and entry work", () => {
  const expectedConfig = expectedAddressConfig();
  const oversized = inspectForwardedFor("x".repeat(4097), expectedConfig);
  assert.equal(oversized.tooLarge, true);
  assert.equal(oversized.inspectedCount, 0);

  const bounded = inspectForwardedFor(
    Array.from({ length: 20 }, () => "203.0.113.1").join(","),
    expectedConfig,
  );
  assert.equal(bounded.entryCount, 20);
  assert.equal(bounded.inspectedCount, 16);
  assert.equal(bounded.omittedCount, 4);
});

test("expected public addresses match only equivalent forwarded entries", () => {
  const expectedIPv4 = "8.8.8.8";
  const expectedIPv6 = "2001:4860:4860::8888";
  const environment = {
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: expectedIPv4,
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: expectedIPv6,
  };
  const config = expectedAddressConfig(environment);
  assert.deepEqual(
    { present: config.present, valid: config.valid },
    { present: true, valid: true },
  );

  const result = inspectForwardedFor(
    "8.8.8.8, 1.1.1.1, 2001:4860:4860:0:0:0:0:8888, 2001:4860:4860::8844",
    config,
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.matchesExpectedAddress),
    [true, false, true, false],
  );

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(expectedIPv4), false);
  assert.equal(serialized.includes(expectedIPv6), false);
});

test("IPv4-mapped IPv6 and expanded IPv6 normalize to the same addresses", () => {
  const mappedIPv6Config = expectedAddressConfig({
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "::ffff:8.8.8.8",
  });
  const mappedResult = inspectForwardedFor(
    "8.8.8.8, 0:0:0:0:0:ffff:808:808",
    mappedIPv6Config,
  );
  assert.deepEqual(
    mappedResult.entries.map((entry) => entry.matchesExpectedAddress),
    [true, true],
  );

  const expandedIPv6Config = expectedAddressConfig({
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6:
      "2001:4860:4860:0000:0000:0000:0000:8888",
  });
  const expandedResult = inspectForwardedFor(
    "2001:4860:4860::8888",
    expandedIPv6Config,
  );
  assert.equal(expandedResult.entries[0].matchesExpectedAddress, true);
});

test("missing and invalid expected-address settings are reported without matching", () => {
  const missing = expectedAddressConfig();
  assert.deepEqual(
    { present: missing.present, valid: missing.valid },
    { present: false, valid: false },
  );

  for (const invalidSettings of [
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: "" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: "10.1.2.3" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: "192.0.2.44" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: "2001:4860::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "fc00::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "fe80::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "2001:db8::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "2001:2::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "2002:808:808::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "3fff::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "::ffff:10.1.2.3" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "ff02::1" },
    { NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "8.8.8.8" },
    {
      NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: "8.8.8.8",
      NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6: "invalid",
    },
  ]) {
    const config = expectedAddressConfig(invalidSettings);
    assert.deepEqual(
      { present: config.present, valid: config.valid },
      { present: true, valid: false },
    );
    const result = inspectForwardedFor("8.8.8.8", config);
    assert.equal(result.entries[0].matchesExpectedAddress, false);
  }
});

test("rate limiter allows six requests per minute", () => {
  let now = 1000;
  const limiter = createCountryIpDiagnosticRateLimiter({ now: () => now });
  for (let count = 0; count < 6; count += 1) {
    assert.equal(limiter.allow(), true);
  }
  assert.equal(limiter.allow(), false);
  now += 60_000;
  assert.equal(limiter.allow(), true);
});

test("route is disabled by default, exact-shop restricted, and reports country unavailable", async () => {
  let disabledAuthCalls = 0;
  const authenticate = {
    public: {
      appProxy: async () => ({ session: { shop: operatorShop } }),
    },
  };
  const request = new Request(
    "https://noticepro-app.onrender.com/api/proxy/ip-diagnostic?signature=synthetic-signature",
    { headers: { "X-Forwarded-For": "192.0.2.123" } },
  );

  const disabledLoader = loadDiagnosticRoute({
    env: {},
    authenticate: {
      public: {
        appProxy: async () => {
          disabledAuthCalls += 1;
          return { session: { shop: operatorShop } };
        },
      },
    },
  });
  assert.equal((await disabledLoader({ request })).status, 404);
  assert.equal(disabledAuthCalls, 0);

  const wrongShopLoader = loadDiagnosticRoute({
    env: activeEnvironment(),
    authenticate: {
      public: {
        appProxy: async () => ({ session: { shop: "other.myshopify.com" } }),
      },
    },
  });
  assert.equal((await wrongShopLoader({ request })).status, 404);

  const loader = loadDiagnosticRoute({
    env: activeEnvironment(),
    authenticate,
  });
  const response = await loader({ request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bodyText = await response.text();
  for (const value of ["192.0.2.123", "synthetic-signature"]) {
    assert.equal(bodyText.includes(value), false);
  }
  assert.deepEqual(JSON.parse(bodyText), {
    headerTrust: "unverified",
    countryVerdicts: "unavailable",
    expectedAddressConfig: { present: false, valid: false },
    forwardedFor: {
      present: true,
      tooLarge: false,
      entryCount: 1,
      inspectedCount: 1,
      omittedCount: 0,
      entries: [
        {
          position: 0,
          addressFamily: "ipv4",
          verdict: "synthetic-ipv4",
          matchesExpectedAddress: false,
        },
      ],
    },
  });
});

test("route compares private expected settings in memory and ignores request-supplied values", async () => {
  const expectedIPv4 = "8.8.8.8";
  const env = {
    ...activeEnvironment(),
    NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4: expectedIPv4,
  };
  const request = new Request(
    "https://noticepro-app.onrender.com/api/proxy/ip-diagnostic?expected_ipv4=1.1.1.1",
    { headers: { "X-Forwarded-For": "8.8.8.8, 1.1.1.1" } },
  );
  const loader = loadDiagnosticRoute({
    env,
    authenticate: {
      public: {
        appProxy: async () => ({ session: { shop: operatorShop } }),
      },
    },
  });

  const response = await loader({ request });
  const bodyText = await response.text();
  assert.equal(bodyText.includes(expectedIPv4), false);
  assert.equal(bodyText.includes("1.1.1.1"), false);
  assert.deepEqual(JSON.parse(bodyText).expectedAddressConfig, {
    present: true,
    valid: true,
  });
  assert.deepEqual(
    JSON.parse(bodyText).forwardedFor.entries.map(
      (entry) => entry.matchesExpectedAddress,
    ),
    [true, false],
  );
});

test("authentication errors return generic responses without external error bodies", async () => {
  for (const [error, expectedStatus] of [
    [new Response("detailed signature error", { status: 401 }), 401],
    [new Error("external detail containing an address 203.0.113.45"), 503],
  ]) {
    const loader = loadDiagnosticRoute({
      env: activeEnvironment(),
      authenticate: {
        public: {
          appProxy: async () => {
            throw error;
          },
        },
      },
    });
    const response = await loader({
      request: new Request("https://noticepro-app.onrender.com/api/proxy/ip-diagnostic"),
    });
    assert.equal(response.status, expectedStatus);
    const body = await response.text();
    assert.equal(body.includes("detailed signature error"), false);
    assert.equal(body.includes("203.0.113.45"), false);
  }
});

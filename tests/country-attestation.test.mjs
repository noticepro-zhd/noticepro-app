import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  issueCountryChallenge,
  readCountryAttestationConfiguration,
  verifyCountryAttestation,
} from "../app/features/widgets/country-attestation.server.ts";
import {
  createCountryAttestationWorker,
} from "../country-attestation-worker/src/index.js";
import {
  boundCountryAttestationRequest,
  resolveVisitorCountry,
} from "../app/features/widgets/country-resolution.server.ts";

const SECRET = "a".repeat(64);
const SHOP = "noticepro-test.myshopify.com";

function requestWithCountry(country, challenge, extra = {}) {
  const request = new Request(
    "https://worker.test/attest?country=CA&ip=192.0.2.45",
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "CF-IPCountry": "JP",
        "X-Forwarded-For": "198.51.100.8",
        ...extra.headers,
      },
      body: challenge,
    },
  );
  Object.defineProperty(request, "cf", { value: country === undefined ? {} : { country } });
  return request;
}

function corruptSignature(token) {
  const parts = token.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  return parts.join(".");
}

test("attestation configuration is disabled by default and rejects incomplete or unsafe values", () => {
  assert.deepEqual(readCountryAttestationConfiguration({}), {
    enabled: false,
    secret: null,
    workerUrl: null,
  });
  assert.deepEqual(
    readCountryAttestationConfiguration({
      NOTICEPRO_COUNTRY_ATTESTATION_ENABLED: "true",
      NOTICEPRO_COUNTRY_ATTESTATION_SECRET: "private-secret-value",
      NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL: "http://worker.test/attest",
    }),
    { enabled: false, secret: null, workerUrl: null },
  );
  assert.deepEqual(
    readCountryAttestationConfiguration({
      NOTICEPRO_COUNTRY_ATTESTATION_ENABLED: "TRUE",
      NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET,
      NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL:
        "https://worker.test/attest",
    }),
    { enabled: false, secret: null, workerUrl: null },
  );
  assert.deepEqual(
    readCountryAttestationConfiguration({
      NOTICEPRO_COUNTRY_ATTESTATION_ENABLED: "true",
      NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET,
      NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL:
        "https://user:password@worker.test/attest?token=hidden",
    }),
    { enabled: false, secret: null, workerUrl: null },
  );
});

test("Worker signs only request.cf.country and Render verifies its challenge-bound assertion", async () => {
  const now = 1_800_000_000_000;
  const challenge = issueCountryChallenge(SHOP, SECRET, now);
  const worker = createCountryAttestationWorker(() => now);
  const response = await worker.fetch(
    requestWithCountry("US", challenge),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    verifyCountryAttestation(challenge, result.assertion, SHOP, SECRET, now),
    "US",
  );
  const assertionClaims = JSON.parse(
    Buffer.from(result.assertion.split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(assertionClaims.country, "US");
  assert.equal(JSON.stringify(result).includes("192.0.2.45"), false);
  assert.equal(JSON.stringify(result).includes("198.51.100.8"), false);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
});

test("challenge and assertion tampering, expiry, and wrong-shop relay are rejected", async () => {
  const now = 1_800_000_000_000;
  const worker = createCountryAttestationWorker(() => now);
  const challenge = issueCountryChallenge(SHOP, SECRET, now);

  const badChallengeResponse = await worker.fetch(
    requestWithCountry("US", corruptSignature(challenge)),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(badChallengeResponse.status, 401);

  const response = await worker.fetch(
    requestWithCountry("US", challenge),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  const { assertion } = await response.json();
  assert.equal(
    verifyCountryAttestation(
      challenge,
      corruptSignature(assertion),
      SHOP,
      SECRET,
      now,
    ),
    null,
  );
  assert.equal(
    verifyCountryAttestation(
      challenge,
      assertion,
      "different-shop.myshopify.com",
      SECRET,
      now,
    ),
    null,
  );
  assert.equal(
    verifyCountryAttestation(
      challenge,
      assertion,
      SHOP,
      SECRET,
      now + 121_000,
    ),
    null,
  );
});

test("unknown edge country, absent edge country, malformed challenge, and missing secret fail closed", async () => {
  const now = 1_800_000_000_000;
  const worker = createCountryAttestationWorker(() => now);
  const challenge = issueCountryChallenge(SHOP, SECRET, now);

  const unsupportedResponse = await worker.fetch(
    requestWithCountry("XK", challenge),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  const unsupported = await unsupportedResponse.json();
  assert.equal(
    verifyCountryAttestation(challenge, unsupported.assertion, SHOP, SECRET, now),
    null,
  );

  const noEdgeCountry = await worker.fetch(
    requestWithCountry(undefined, challenge),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(noEdgeCountry.status, 204);

  const malformedBody = await worker.fetch(
    requestWithCountry("US", "not-a-challenge"),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(malformedBody.status, 401);

  const oversizedBody = await worker.fetch(
    requestWithCountry("US", "x".repeat(3000)),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(oversizedBody.status, 400);

  const missingSecret = await worker.fetch(requestWithCountry("US", challenge), {});
  assert.equal(missingSecret.status, 503);

  const expiredWorker = createCountryAttestationWorker(() => now + 181_000);
  const expired = await expiredWorker.fetch(
    requestWithCountry("US", challenge),
    { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(expired.status, 401);
});

test("country resolution stays unknown without valid server configuration or a matching signed body", async () => {
  const saved = {
    enabled: process.env.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED,
    secret: process.env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET,
    workerUrl: process.env.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL,
  };
  delete process.env.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED;
  delete process.env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET;
  delete process.env.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL;

  try {
    const request = new Request(
      "https://shop.test/apps/notice-pro?country=US",
      {
        headers: {
          "CF-IPCountry": "US",
          "X-Forwarded-For": "198.51.100.12",
        },
      },
    );
    assert.equal(await resolveVisitorCountry(request, SHOP), null);

    process.env.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED = "true";
    process.env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET = SECRET;
    process.env.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL =
      "https://worker.test/attest";

    const now = Date.now();
    const challenge = issueCountryChallenge(SHOP, SECRET, now);
    const worker = createCountryAttestationWorker(() => now);
    const assertionResponse = await worker.fetch(
      requestWithCountry("CA", challenge),
      { NOTICEPRO_COUNTRY_ATTESTATION_SECRET: SECRET },
    );
    const { assertion } = await assertionResponse.json();
    const validRequest = new Request("https://shop.test/apps/notice-pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, assertion }),
    });

    assert.equal(await resolveVisitorCountry(validRequest.clone(), SHOP), "CA");
    assert.equal(
      await resolveVisitorCountry(validRequest.clone(), "other.myshopify.com"),
      null,
    );

    const extraFieldRequest = new Request("https://shop.test/apps/notice-pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, assertion, country: "US" }),
    });
    assert.equal(await resolveVisitorCountry(extraFieldRequest, SHOP), null);

    const oversizedRequest = new Request("https://shop.test/apps/notice-pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: "x".repeat(5000), assertion }),
    });
    assert.equal(await resolveVisitorCountry(oversizedRequest, SHOP), null);
  } finally {
    for (const [name, value] of [
      ["NOTICEPRO_COUNTRY_ATTESTATION_ENABLED", saved.enabled],
      ["NOTICEPRO_COUNTRY_ATTESTATION_SECRET", saved.secret],
      ["NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL", saved.workerUrl],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("App Proxy attestation request bodies are bounded before widget filtering", async () => {
  const oversized = new Request("https://storefront.test/apps/noticepro/widget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: "x".repeat(10_000) }),
  });
  const bounded = await boundCountryAttestationRequest(oversized);

  assert.equal(bounded.method, "POST");
  assert.equal(bounded.headers.get("Content-Type"), "application/json");
  assert.equal(await bounded.text(), "{}");
});

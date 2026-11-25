import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { SUPPORTED_COUNTRY_CODES } from "./country-data.ts";

const TOKEN_AUDIENCE = "noticepro-country-targeting";
const CHALLENGE_TTL_SECONDS = 180;
const ASSERTION_TTL_SECONDS = 120;
const MAX_TOKEN_LENGTH = 2048;
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type TokenKind = "challenge" | "assertion";

type TokenClaims = {
  v: 1;
  kind: TokenKind;
  aud: string;
  shop: string;
  nonce: string;
  iat: number;
  exp: number;
  country?: string;
};

export type CountryAttestationConfiguration = {
  enabled: boolean;
  secret: string | null;
  workerUrl: string | null;
};

function isValidSecret(secret: string | undefined): secret is string {
  return (
    typeof secret === "string" &&
    /^[\x20-\x7e]{32,512}$/.test(secret)
  );
}

function readWorkerUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/attest" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function readCountryAttestationConfiguration(
  environment: Record<string, string | undefined> = process.env,
): CountryAttestationConfiguration {
  if (environment.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED !== "true") {
    return { enabled: false, secret: null, workerUrl: null };
  }

  const secret = environment.NOTICEPRO_COUNTRY_ATTESTATION_SECRET;
  const workerUrl = readWorkerUrl(
    environment.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL,
  );

  if (!isValidSecret(secret) || !workerUrl) {
    return { enabled: false, secret: null, workerUrl: null };
  }

  return { enabled: true, secret, workerUrl };
}

function tokenSignature(
  kind: TokenKind,
  payload: string,
  secret: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`noticepro-country:${kind}:v1.${payload}`)
    .digest();
}

function encodeToken(kind: TokenKind, claims: TokenClaims, secret: string) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = tokenSignature(kind, payload, secret).toString(
    "base64url",
  );

  return `v1.${payload}.${signature}`;
}

function decodeToken(
  token: string,
  kind: TokenKind,
  secret: string,
): TokenClaims | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;

  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !BASE64URL_PATTERN.test(parts[1]) ||
    !BASE64URL_PATTERN.test(parts[2])
  ) {
    return null;
  }

  const actualSignature = Buffer.from(parts[2], "base64url");
  const expectedSignature = tokenSignature(kind, parts[1], secret);

  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as TokenClaims)
      : null;
  } catch {
    return null;
  }
}

function validLifetime(
  claims: TokenClaims,
  nowSeconds: number,
  maxLifetimeSeconds: number,
): boolean {
  return (
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    claims.iat <= nowSeconds + 30 &&
    claims.exp > nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= maxLifetimeSeconds
  );
}

function isChallenge(
  claims: TokenClaims | null,
  shop: string,
  nowSeconds: number,
): claims is TokenClaims {
  return (
    !!claims &&
    claims.v === 1 &&
    claims.kind === "challenge" &&
    claims.aud === TOKEN_AUDIENCE &&
    claims.shop === shop &&
    SHOP_DOMAIN_PATTERN.test(claims.shop) &&
    NONCE_PATTERN.test(claims.nonce) &&
    validLifetime(claims, nowSeconds, CHALLENGE_TTL_SECONDS)
  );
}

export function issueCountryChallenge(
  shop: string,
  secret: string,
  nowMilliseconds = Date.now(),
): string {
  const normalizedShop = shop.toLowerCase();
  if (!SHOP_DOMAIN_PATTERN.test(normalizedShop)) {
    throw new Error("Cannot issue a country challenge for this shop.");
  }

  const iat = Math.floor(nowMilliseconds / 1000);
  return encodeToken(
    "challenge",
    {
      v: 1,
      kind: "challenge",
      aud: TOKEN_AUDIENCE,
      shop: normalizedShop,
      nonce: randomBytes(24).toString("base64url"),
      iat,
      exp: iat + CHALLENGE_TTL_SECONDS,
    },
    secret,
  );
}

export function verifyCountryAttestation(
  challengeToken: string,
  assertionToken: string,
  expectedShop: string,
  secret: string,
  nowMilliseconds = Date.now(),
): string | null {
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const shop = expectedShop.toLowerCase();
  if (!SHOP_DOMAIN_PATTERN.test(shop)) return null;

  const challenge = decodeToken(challengeToken, "challenge", secret);
  const assertion = decodeToken(assertionToken, "assertion", secret);

  if (
    !isChallenge(challenge, shop, nowSeconds) ||
    !assertion ||
    assertion.v !== 1 ||
    assertion.kind !== "assertion" ||
    assertion.aud !== TOKEN_AUDIENCE ||
    assertion.shop !== shop ||
    assertion.nonce !== challenge.nonce ||
    !validLifetime(assertion, nowSeconds, ASSERTION_TTL_SECONDS) ||
    assertion.iat < challenge.iat - 30 ||
    assertion.exp > challenge.exp ||
    typeof assertion.country !== "string" ||
    !SUPPORTED_COUNTRY_CODES.has(assertion.country)
  ) {
    return null;
  }

  return assertion.country;
}

const TOKEN_AUDIENCE = "noticepro-country-targeting";
const CHALLENGE_TTL_SECONDS = 180;
const ASSERTION_TTL_SECONDS = 120;
const MAX_BODY_BYTES = 2048;
const MAX_TOKEN_LENGTH = 2048;
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, max-age=0",
  Vary: "Origin",
};

function response(status, body = null, extraHeaders = {}) {
  const headers = new Headers(CORS_HEADERS);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  if (body !== null) headers.set("Content-Type", "application/json");
  return new Response(body, { status, headers });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  if (!BASE64URL_PATTERN.test(value)) return null;

  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytesToBase64Url(bytes) === value ? bytes : null;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signToken(kind, claims, key) {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`noticepro-country:${kind}:v1.${payload}`),
  );
  return `v1.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function readToken(token, kind, key) {
  if (token.length > MAX_TOKEN_LENGTH) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const payloadBytes = base64UrlToBytes(parts[1]);
  const signatureBytes = base64UrlToBytes(parts[2]);
  if (!payloadBytes || !signatureBytes) return null;

  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(
      `noticepro-country:${kind}:v1.${parts[1]}`,
    ),
  );
  if (!isValid) return null;

  try {
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? claims
      : null;
  } catch {
    return null;
  }
}

function validLifetime(claims, nowSeconds, maximumSeconds) {
  return (
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    claims.iat <= nowSeconds + 30 &&
    claims.exp > nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= maximumSeconds
  );
}

function isValidChallenge(claims, nowSeconds) {
  return (
    claims?.v === 1 &&
    claims.kind === "challenge" &&
    claims.aud === TOKEN_AUDIENCE &&
    typeof claims.shop === "string" &&
    SHOP_DOMAIN_PATTERN.test(claims.shop) &&
    typeof claims.nonce === "string" &&
    NONCE_PATTERN.test(claims.nonce) &&
    validLifetime(claims, nowSeconds, CHALLENGE_TTL_SECONDS)
  );
}

async function readBoundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks = [];
  let size = 0;
  let done = false;
  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength)) {
      if (Number(declaredLength) > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
    }

    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }

    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function createCountryAttestationWorker(now = () => Date.now()) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== "/attest") return response(404);
      if (request.method === "OPTIONS") return response(204);
      if (request.method !== "POST") {
        return response(405, null, { Allow: "POST, OPTIONS" });
      }

      const contentType = request.headers.get("content-type") ?? "";
      if (!/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        return response(415);
      }

      const challengeToken = await readBoundedBody(request);
      if (!challengeToken || challengeToken.length > MAX_TOKEN_LENGTH) {
        return response(400);
      }

      const secret = env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET;
      if (
        typeof secret !== "string" ||
        !/^[\x20-\x7e]{32,512}$/.test(secret)
      ) {
        return response(503);
      }

      try {
        const key = await importHmacKey(secret);
        const challenge = await readToken(challengeToken, "challenge", key);
        const nowSeconds = Math.floor(now() / 1000);
        if (!isValidChallenge(challenge, nowSeconds)) {
          return response(401);
        }

        const country = request.cf?.country;
        if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
          return response(204);
        }

        const iat = nowSeconds;
        const exp = Math.min(iat + ASSERTION_TTL_SECONDS, challenge.exp);
        if (exp <= nowSeconds) return response(204);

        const assertion = await signToken(
          "assertion",
          {
            v: 1,
            kind: "assertion",
            aud: TOKEN_AUDIENCE,
            shop: challenge.shop,
            nonce: challenge.nonce,
            country,
            iat,
            exp,
          },
          key,
        );

        return response(
          200,
          JSON.stringify({ assertion, expiresAt: exp }),
        );
      } catch {
        return response(503);
      }
    },
  };
}

export default createCountryAttestationWorker();

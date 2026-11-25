import { Buffer } from "node:buffer";

import {
  readCountryAttestationConfiguration,
  verifyCountryAttestation,
} from "./country-attestation.server.ts";

const MAX_ATTESTATION_BODY_BYTES = 4096;

async function readBoundedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let done = false;

  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength)) {
      if (Number(declaredLength) > MAX_ATTESTATION_BODY_BYTES) {
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

      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_ATTESTATION_BODY_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(result.value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

export async function boundCountryAttestationRequest(
  request: Request,
): Promise<Request> {
  if (request.method !== "POST") return request;

  const contentType = request.headers.get("content-type") ?? "application/json";
  const body = await readBoundedBody(request);

  return new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: body ?? "{}",
  });
}

async function readAttestationBody(
  request: Request,
): Promise<{ challenge: string; assertion: string } | null> {
  if (request.method !== "POST") return null;

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return null;
  }

  const body = await readBoundedBody(request);
  if (body === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    typeof (parsed as Record<string, unknown>).challenge !== "string" ||
    typeof (parsed as Record<string, unknown>).assertion !== "string" ||
    (parsed as Record<string, string>).challenge.length > 2048 ||
    (parsed as Record<string, string>).assertion.length > 2048
  ) {
    return null;
  }

  return parsed as { challenge: string; assertion: string };
}

export async function resolveVisitorCountry(
  request: Request,
  shop: string,
): Promise<string | null> {
  const configuration = readCountryAttestationConfiguration();
  if (!configuration.enabled || !configuration.secret) return null;

  const attestation = await readAttestationBody(request);
  if (!attestation) return null;

  return verifyCountryAttestation(
    attestation.challenge,
    attestation.assertion,
    shop,
    configuration.secret,
  );
}

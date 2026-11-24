import { isIP } from "node:net";

import { SUPPORTED_COUNTRY_CODES } from "./country-data.ts";

const MAX_ACTIVE_DURATION_MS = 30 * 60 * 1000;
const MAX_HEADER_LENGTH = 4096;
const MAX_INSPECTED_ENTRIES = 16;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 6;

const SYNTHETIC_IPV4 = "192.0.2.123";
const SYNTHETIC_IPV6 = "2001:db8::123";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type CountryLookup = (ipAddress: string) => Promise<string | null>;

export type CountryIpDiagnosticConfig = Readonly<{
  shop: string;
  expectedCountry: string;
  startsAt: number;
  expiresAt: number;
}>;

export type ForwardedForObservation = Readonly<{
  present: boolean;
  tooLarge: boolean;
  entryCount: number;
  inspectedCount: number;
  omittedCount: number;
  entries: readonly Readonly<{
    position: number;
    addressFamily: "ipv4" | "ipv6" | null;
    verdict:
      | "expected-country"
      | "other-country"
      | "unknown-country"
      | "lookup-error"
      | "malformed"
      | "synthetic-ipv4"
      | "synthetic-ipv6";
  }>[];
}>;

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  try {
    return new Date(timestamp).toISOString() === value ? timestamp : null;
  } catch {
    return null;
  }
}

export function readCountryIpDiagnosticConfig(
  env: RuntimeEnvironment = process.env,
  now = Date.now(),
): CountryIpDiagnosticConfig | null {
  if (env.NOTICEPRO_IP_DIAGNOSTICS_ENABLED !== "true") return null;

  const shop = env.NOTICEPRO_IP_DIAGNOSTICS_SHOP?.trim().toLowerCase();
  const expectedCountry =
    env.NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_COUNTRY?.trim();
  const startsAt = parseIsoTimestamp(
    env.NOTICEPRO_IP_DIAGNOSTICS_STARTS_AT,
  );
  const expiresAt = parseIsoTimestamp(
    env.NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT,
  );

  if (
    !shop ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
    !expectedCountry ||
    !SUPPORTED_COUNTRY_CODES.has(expectedCountry) ||
    startsAt === null ||
    expiresAt === null ||
    startsAt > now ||
    expiresAt <= now ||
    expiresAt <= startsAt ||
    expiresAt - startsAt > MAX_ACTIVE_DURATION_MS
  ) {
    return null;
  }

  return { shop, expectedCountry, startsAt, expiresAt };
}

export async function inspectForwardedFor(
  value: string | null,
  expectedCountry: string,
  lookupCountry: CountryLookup,
): Promise<ForwardedForObservation> {
  if (value === null) {
    return {
      present: false,
      tooLarge: false,
      entryCount: 0,
      inspectedCount: 0,
      omittedCount: 0,
      entries: [],
    };
  }

  if (value.length > MAX_HEADER_LENGTH) {
    return {
      present: true,
      tooLarge: true,
      entryCount: 0,
      inspectedCount: 0,
      omittedCount: 0,
      entries: [],
    };
  }

  const values = value.split(",");
  const inspected = values.slice(0, MAX_INSPECTED_ENTRIES);
  const entries: ForwardedForObservation["entries"][number][] = [];

  for (const [position, rawValue] of inspected.entries()) {
    const candidate = rawValue.trim();
    const addressFamily = isIP(candidate);

    if (candidate === SYNTHETIC_IPV4) {
      entries.push({ position, addressFamily: "ipv4", verdict: "synthetic-ipv4" });
      continue;
    }

    if (candidate.toLowerCase() === SYNTHETIC_IPV6) {
      entries.push({ position, addressFamily: "ipv6", verdict: "synthetic-ipv6" });
      continue;
    }

    if (addressFamily === 0) {
      entries.push({ position, addressFamily: null, verdict: "malformed" });
      continue;
    }

    let country: string | null;
    try {
      country = await lookupCountry(candidate);
    } catch {
      entries.push({
        position,
        addressFamily: addressFamily === 4 ? "ipv4" : "ipv6",
        verdict: "lookup-error",
      });
      continue;
    }

    entries.push({
      position,
      addressFamily: addressFamily === 4 ? "ipv4" : "ipv6",
      verdict:
        country === null
          ? "unknown-country"
          : country === expectedCountry
            ? "expected-country"
            : "other-country",
    });
  }

  return {
    present: true,
    tooLarge: false,
    entryCount: values.length,
    inspectedCount: inspected.length,
    omittedCount: values.length - inspected.length,
    entries,
  };
}

export function createCountryIpDiagnosticRateLimiter({
  now = Date.now,
}: {
  now?: () => number;
} = {}) {
  const windows = new Map<string, { startedAt: number; count: number }>();

  return {
    allow(shop: string): boolean {
      const currentTime = now();
      const window = windows.get(shop);

      if (!window || currentTime - window.startedAt >= RATE_LIMIT_WINDOW_MS) {
        windows.clear();
        windows.set(shop, { startedAt: currentTime, count: 1 });
        return true;
      }

      if (window.count >= RATE_LIMIT_REQUESTS) return false;
      window.count += 1;
      return true;
    },
  };
}

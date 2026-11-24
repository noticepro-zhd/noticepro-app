import { isIP } from "node:net";

const OPERATOR_SHOP = "zahidsapp.myshopify.com";
const MAX_ACTIVE_DURATION_MS = 30 * 60 * 1000;
const MAX_HEADER_LENGTH = 4096;
const MAX_INSPECTED_ENTRIES = 16;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 6;

const SYNTHETIC_IPV4 = "192.0.2.123";
const SYNTHETIC_IPV6 = "2001:db8::123";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type CountryIpDiagnosticConfig = Readonly<{
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
      | "valid-ipv4"
      | "valid-ipv6"
      | "synthetic-ipv4"
      | "synthetic-ipv6"
      | "malformed";
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

  const startsAt = parseIsoTimestamp(
    env.NOTICEPRO_IP_DIAGNOSTICS_STARTS_AT,
  );
  const expiresAt = parseIsoTimestamp(
    env.NOTICEPRO_IP_DIAGNOSTICS_EXPIRES_AT,
  );

  if (
    startsAt === null ||
    expiresAt === null ||
    startsAt > now ||
    expiresAt <= now ||
    expiresAt <= startsAt ||
    expiresAt - startsAt > MAX_ACTIVE_DURATION_MS
  ) {
    return null;
  }

  return { startsAt, expiresAt };
}

export function isOperatorDiagnosticShop(shop: string): boolean {
  return shop.toLowerCase() === OPERATOR_SHOP;
}

export function inspectForwardedFor(
  value: string | null,
): ForwardedForObservation {
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
      entries.push({
        position,
        addressFamily: "ipv4",
        verdict: "synthetic-ipv4",
      });
    } else if (candidate.toLowerCase() === SYNTHETIC_IPV6) {
      entries.push({
        position,
        addressFamily: "ipv6",
        verdict: "synthetic-ipv6",
      });
    } else if (addressFamily === 4) {
      entries.push({
        position,
        addressFamily: "ipv4",
        verdict: "valid-ipv4",
      });
    } else if (addressFamily === 6) {
      entries.push({
        position,
        addressFamily: "ipv6",
        verdict: "valid-ipv6",
      });
    } else {
      entries.push({
        position,
        addressFamily: null,
        verdict: "malformed",
      });
    }
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
  let windowStartedAt = 0;
  let count = 0;

  return {
    allow(): boolean {
      const currentTime = now();

      if (currentTime - windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        windowStartedAt = currentTime;
        count = 0;
      }

      if (count >= RATE_LIMIT_REQUESTS) return false;
      count += 1;
      return true;
    },
  };
}

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
  expectedAddressConfig: ExpectedAddressConfig;
}>;

export type ExpectedAddressConfig = Readonly<{
  present: boolean;
  valid: boolean;
  matches: (address: string) => boolean;
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
      | "malformed"
      | "non-public";
    matchesExpectedAddress: boolean;
  }>[];
}>;

function parseIPv4Bytes(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function parseIPv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;

  let expandedAddress = address.toLowerCase();
  if (expandedAddress.includes(".")) {
    const lastColon = expandedAddress.lastIndexOf(":");
    const ipv4Bytes = parseIPv4Bytes(expandedAddress.slice(lastColon + 1));
    if (!ipv4Bytes) return null;

    const firstWord = ((ipv4Bytes[0] << 8) | ipv4Bytes[1]).toString(16);
    const secondWord = ((ipv4Bytes[2] << 8) | ipv4Bytes[3]).toString(16);
    expandedAddress =
      `${expandedAddress.slice(0, lastColon + 1)}${firstWord}:${secondWord}`;
  }

  const compressionIndex = expandedAddress.indexOf("::");
  let words: string[];
  if (compressionIndex >= 0) {
    const left = expandedAddress.slice(0, compressionIndex);
    const right = expandedAddress.slice(compressionIndex + 2);
    const leftWords = left ? left.split(":") : [];
    const rightWords = right ? right.split(":") : [];
    const zeroCount = 8 - leftWords.length - rightWords.length;
    if (zeroCount < 1) return null;
    words = [...leftWords, ...Array.from({ length: zeroCount }, () => "0"), ...rightWords];
  } else {
    words = expandedAddress.split(":");
  }

  if (words.length !== 8) return null;
  const numericWords = words.map((word) => Number.parseInt(word, 16));
  if (numericWords.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }

  return numericWords.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
}

function isPublicIPv4(bytes: readonly number[]): boolean {
  const [first, second, third] = bytes;

  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (
    first === 192 &&
    (second === 0 ||
      second === 2 ||
      second === 88 && third === 99 ||
      second === 168 ||
      second === 31 && third === 196 ||
      second === 52 && third === 193 ||
      second === 175 && third === 48)
  ) {
    return false;
  }
  if (
    first === 198 &&
    (second === 18 || second === 19 || second === 51 && third === 100)
  ) {
    return false;
  }
  if (first === 203 && second === 0 && third === 113) return false;

  return true;
}

function isIPv4MappedIPv6(bytes: readonly number[]): boolean {
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

function normalizePublicAddress(address: string): string | null {
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIPv4Bytes(address);
    return bytes && isPublicIPv4(bytes) ? `ipv4:${bytes.join(".")}` : null;
  }

  if (version !== 6) return null;

  const bytes = parseIPv6Bytes(address);
  if (!bytes) return null;

  if (isIPv4MappedIPv6(bytes)) {
    const ipv4Bytes = bytes.slice(12);
    return isPublicIPv4(ipv4Bytes)
      ? `ipv4:${ipv4Bytes.join(".")}`
      : null;
  }

  const inGlobalUnicastRange = (bytes[0] & 0xe0) === 0x20;
  const inProtocolAssignments =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    ((bytes[2] << 8) | bytes[3]) <= 0x01ff;
  const inDocumentationRange =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  const inSixToFourRange = bytes[0] === 0x20 && bytes[1] === 0x02;
  const inDocumentationPrefix =
    bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0;

  if (
    !inGlobalUnicastRange ||
    inProtocolAssignments ||
    inDocumentationRange ||
    inSixToFourRange ||
    inDocumentationPrefix
  ) {
    return null;
  }

  return `ipv6:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readExpectedAddressConfig(
  env: RuntimeEnvironment,
): ExpectedAddressConfig {
  const ipv4Value = env.NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4;
  const ipv6Value = env.NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6;
  const present = ipv4Value !== undefined || ipv6Value !== undefined;
  const normalizedAddresses = new Set<string>();
  let valid = present;

  if (ipv4Value !== undefined) {
    const ipv4 = ipv4Value.trim();
    const normalized = isIP(ipv4) === 4 ? normalizePublicAddress(ipv4) : null;
    if (normalized === null) valid = false;
    else normalizedAddresses.add(normalized);
  }

  if (ipv6Value !== undefined) {
    const ipv6 = ipv6Value.trim();
    const normalized = isIP(ipv6) === 6 ? normalizePublicAddress(ipv6) : null;
    if (normalized === null) valid = false;
    else normalizedAddresses.add(normalized);
  }

  if (!valid) normalizedAddresses.clear();

  return {
    present,
    valid,
    matches(address: string): boolean {
      const normalized = normalizePublicAddress(address);
      return valid && normalized !== null && normalizedAddresses.has(normalized);
    },
  };
}

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

  return {
    startsAt,
    expiresAt,
    expectedAddressConfig: readExpectedAddressConfig(env),
  };
}

export function isOperatorDiagnosticShop(shop: string): boolean {
  return shop.toLowerCase() === OPERATOR_SHOP;
}

export function inspectForwardedFor(
  value: string | null,
  expectedAddressConfig: ExpectedAddressConfig,
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
        matchesExpectedAddress: false,
      });
    } else if (candidate.toLowerCase() === SYNTHETIC_IPV6) {
      entries.push({
        position,
        addressFamily: "ipv6",
        verdict: "synthetic-ipv6",
        matchesExpectedAddress: false,
      });
    } else if (addressFamily !== 0 && normalizePublicAddress(candidate) === null) {
      entries.push({
        position,
        addressFamily: addressFamily === 4 ? "ipv4" : "ipv6",
        verdict: "non-public",
        matchesExpectedAddress: false,
      });
    } else if (addressFamily === 4) {
      entries.push({
        position,
        addressFamily: "ipv4",
        verdict: "valid-ipv4",
        matchesExpectedAddress: expectedAddressConfig.matches(candidate),
      });
    } else if (addressFamily === 6) {
      entries.push({
        position,
        addressFamily: "ipv6",
        verdict: "valid-ipv6",
        matchesExpectedAddress: expectedAddressConfig.matches(candidate),
      });
    } else {
      entries.push({
        position,
        addressFamily: null,
        verdict: "malformed",
        matchesExpectedAddress: false,
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

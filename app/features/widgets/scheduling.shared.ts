export type ScheduleParseResult =
  { ok: true; date: Date | null } | { ok: false; error: string };

type DateValue = Date | string | null | undefined;

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string) {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  // Keep this module-level cache bounded.
  if (formatters.size >= 64) formatters.clear();
  formatters.set(timeZone, formatter);

  return formatter;
}

export function isValidScheduleTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;

  try {
    getFormatter(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timeZone: string) {
  const values: Record<string, number> = {};

  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function partsAsUtc(parts: ReturnType<typeof zonedParts>): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function toScheduleInput(value: DateValue, timeZone: string): string {
  if (value === null || value === undefined || value === "") return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid saved schedule date.");
  }

  const parts = zonedParts(date, timeZone);

  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

export function formatSchedule(value: DateValue, timeZone: string): string {
  const input = toScheduleInput(value, timeZone);
  if (!input) return "";

  return `${input.replace("T", " ")} (${timeZone})`;
}

export function parseScheduleInput(
  value: string,
  timeZone: string,
): ScheduleParseResult {
  if (!isValidScheduleTimeZone(timeZone)) {
    return {
      ok: false,
      error: "Store timezone is unavailable. Reload and try again.",
    };
  }

  const input = value.trim();

  if (!input) return { ok: true, date: null };

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    input,
  );

  if (!match) {
    return { ok: false, error: "Please enter a valid date and time." };
  }

  const requested = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };

  if (
    requested.year < 1 ||
    requested.month < 1 ||
    requested.month > 12 ||
    requested.day < 1 ||
    requested.day > 31 ||
    requested.hour > 23 ||
    requested.minute > 59 ||
    requested.second > 59
  ) {
    return { ok: false, error: "Please enter a valid date and time." };
  }

  const wallTime = partsAsUtc(requested);
  const check = new Date(wallTime);

  // Reject calendar overflow such as February 30.
  if (
    check.getUTCFullYear() !== requested.year ||
    check.getUTCMonth() + 1 !== requested.month ||
    check.getUTCDate() !== requested.day
  ) {
    return { ok: false, error: "Please enter a valid calendar date." };
  }

  // Discover nearby offsets on both sides of timezone transitions.
  const offsets = new Set<number>();

  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wallTime + hours * 60 * 60 * 1000;
    const localParts = zonedParts(new Date(probe), timeZone);
    offsets.add(partsAsUtc(localParts) - probe);
  }

  const candidates = new Set<number>();

  for (const offset of offsets) {
    const candidate = wallTime - offset;
    const actual = zonedParts(new Date(candidate), timeZone);

    if (
      actual.year === requested.year &&
      actual.month === requested.month &&
      actual.day === requested.day &&
      actual.hour === requested.hour &&
      actual.minute === requested.minute &&
      actual.second === requested.second
    ) {
      candidates.add(candidate);
    }
  }

  if (candidates.size === 0) {
    return {
      ok: false,
      error:
        "This local time does not exist because of a timezone change. Choose another time.",
    };
  }

  if (candidates.size > 1) {
    return {
      ok: false,
      error:
        "This local time occurs twice because of a timezone change. Choose an unambiguous time.",
    };
  }

  return {
    ok: true,
    date: new Date([...candidates][0]),
  };
}

export function parseScheduleInputPreservingInstant(
  value: string,
  timeZone: string,
  existingValue: DateValue,
): ScheduleParseResult {
  if (!isValidScheduleTimeZone(timeZone)) {
    return {
      ok: false,
      error: "Store timezone is unavailable. Reload and try again.",
    };
  }

  if (
    existingValue !== null &&
    existingValue !== undefined &&
    existingValue !== ""
  ) {
    const existingDate = new Date(existingValue);

    if (Number.isNaN(existingDate.getTime())) {
      return {
        ok: false,
        error: "The saved schedule is invalid. Please reload and try again.",
      };
    }

    const existingInput = toScheduleInput(existingDate, timeZone);

    // Browsers may omit :00 seconds from datetime-local values.
    const normalizedInput = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.trim())
      ? `${value.trim()}:00`
      : value.trim();

    if (normalizedInput === existingInput) {
      return { ok: true, date: existingDate };
    }
  }

  return parseScheduleInput(value, timeZone);
}

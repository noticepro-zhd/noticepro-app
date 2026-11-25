import {
  COUNTRY_OPTIONS,
  SUPPORTED_COUNTRY_CODES,
} from "./country-data.ts";

export const COUNTRY_TARGETING_MODES = {
  ALL: "ALL",
  SELECTED: "SELECTED",
} as const;

export type CountryTargetingMode =
  (typeof COUNTRY_TARGETING_MODES)[keyof typeof COUNTRY_TARGETING_MODES];

export type CountryTargeting = {
  countryTargetingMode: CountryTargetingMode;
  targetCountryCodes: string[];
};

export type CountryTargetingResult =
  | { ok: true; data: CountryTargeting }
  | { ok: false; error: string };

type PersistedCountryTargeting = {
  countryTargetingMode?: string | null;
  targetCountryCodes?: string[] | null;
};

function validateCountryTargeting(
  mode: unknown,
  countryCodes: unknown,
): CountryTargetingResult {
  if (
    mode !== COUNTRY_TARGETING_MODES.ALL &&
    mode !== COUNTRY_TARGETING_MODES.SELECTED
  ) {
    return { ok: false, error: "Choose All countries or Selected countries." };
  }

  if (!Array.isArray(countryCodes)) {
    return { ok: false, error: "The country selection is invalid." };
  }

  const seen = new Set<string>();

  for (const code of countryCodes) {
    if (typeof code !== "string" || !SUPPORTED_COUNTRY_CODES.has(code)) {
      return {
        ok: false,
        error: "Choose valid countries from the list.",
      };
    }

    if (seen.has(code)) {
      return {
        ok: false,
        error: "Each country can only be selected once.",
      };
    }

    seen.add(code);
  }

  if (mode === COUNTRY_TARGETING_MODES.ALL) {
    return {
      ok: true,
      data: {
        countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
        targetCountryCodes: [],
      },
    };
  }

  if (countryCodes.length === 0) {
    return {
      ok: false,
      error: "Select at least one country, or choose All countries.",
    };
  }

  return {
    ok: true,
    data: {
      countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
      targetCountryCodes: [...countryCodes],
    },
  };
}

export function readCountryTargetingForm(
  formData: FormData,
  existing?: PersistedCountryTargeting | null,
): CountryTargetingResult {
  const modeEntries = formData.getAll("countryTargetingMode");
  const countryEntries = formData.getAll("targetCountryCodes");

  if (modeEntries.length === 0 && countryEntries.length === 0) {
    if (!existing) {
      return validateCountryTargeting(
        COUNTRY_TARGETING_MODES.ALL,
        [],
      );
    }

    return validateCountryTargeting(
      existing.countryTargetingMode ?? COUNTRY_TARGETING_MODES.ALL,
      existing.targetCountryCodes ?? [],
    );
  }

  if (modeEntries.length !== 1 || countryEntries.length !== 1) {
    return {
      ok: false,
      error: "The country selection is incomplete.",
    };
  }

  const mode = modeEntries[0];
  const serializedCountries = countryEntries[0];

  if (
    typeof mode !== "string" ||
    typeof serializedCountries !== "string"
  ) {
    return {
      ok: false,
      error: "The country selection is invalid.",
    };
  }

  let countryCodes: unknown;

  try {
    countryCodes = JSON.parse(serializedCountries);
  } catch {
    return {
      ok: false,
      error: "The country selection is invalid.",
    };
  }

  return validateCountryTargeting(mode, countryCodes);
}

export function matchesCountryTargeting(
  targeting: CountryTargeting,
  resolvedCountry: string | null,
): boolean {
  if (targeting.countryTargetingMode === COUNTRY_TARGETING_MODES.ALL) {
    return true;
  }

  return (
    targeting.countryTargetingMode === COUNTRY_TARGETING_MODES.SELECTED &&
    typeof resolvedCountry === "string" &&
    SUPPORTED_COUNTRY_CODES.has(resolvedCountry) &&
    targeting.targetCountryCodes.includes(resolvedCountry)
  );
}

export function filterCountryOptions(search: string) {
  const query = search.trim().toLowerCase();

  if (!query) return COUNTRY_OPTIONS;

  return COUNTRY_OPTIONS.filter(
    ({ code, name }) =>
      code.toLowerCase().includes(query) ||
      name.toLowerCase().includes(query),
  );
}

export function toggleCountryCode(
  selectedCodes: string[],
  code: string,
  checked: boolean,
): string[] {
  if (!SUPPORTED_COUNTRY_CODES.has(code)) return selectedCodes;

  if (checked) {
    return selectedCodes.includes(code)
      ? selectedCodes
      : [...selectedCodes, code];
  }

  return selectedCodes.filter((selectedCode) => selectedCode !== code);
}

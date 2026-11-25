import { SUPPORTED_COUNTRY_CODES } from "./country-data.ts";
import {
  COUNTRY_TARGETING_MODES,
  matchesCountryTargeting,
  type CountryTargeting,
} from "./country-targeting.shared.ts";

type CountryTargetingCandidate = {
  countryTargetingMode: string;
  targetCountryCodes: string[];
};

type CountryResolver = (request: Request, shop: string) => Promise<string | null>;

export async function filterByCountryTargeting<
  T extends CountryTargetingCandidate,
>(
  candidates: readonly T[],
  request: Request,
  shop: string,
  resolveCountry: CountryResolver,
): Promise<T[]> {
  const needsResolution = candidates.some(
    ({ countryTargetingMode, targetCountryCodes }) =>
      countryTargetingMode === COUNTRY_TARGETING_MODES.SELECTED &&
      targetCountryCodes.some((code) => SUPPORTED_COUNTRY_CODES.has(code)),
  );

  let resolvedCountry: string | null = null;

  if (needsResolution) {
    try {
      resolvedCountry = await resolveCountry(request, shop);
    } catch {
      console.error(
        "NoticePro country resolution failed; selected-country widgets were excluded.",
      );
    }
  }

  return candidates.filter((candidate) => {
    if (
      candidate.countryTargetingMode !== COUNTRY_TARGETING_MODES.ALL &&
      candidate.countryTargetingMode !== COUNTRY_TARGETING_MODES.SELECTED
    ) {
      return false;
    }

    const targeting: CountryTargeting = {
      countryTargetingMode: candidate.countryTargetingMode,
      targetCountryCodes: candidate.targetCountryCodes,
    };

    return matchesCountryTargeting(targeting, resolvedCountry);
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  COUNTRY_TARGETING_MODES,
  filterCountryOptions,
  matchesCountryTargeting,
  readCountryTargetingForm,
  toggleCountryCode,
} from "../app/features/widgets/country-targeting.shared.ts";
import {
  COUNTRY_OPTIONS,
  SUPPORTED_COUNTRY_CODES,
} from "../app/features/widgets/country-data.ts";

function countryForm(mode, codes) {
  const formData = new FormData();
  if (mode !== undefined) formData.set("countryTargetingMode", mode);
  if (codes !== undefined) {
    formData.set("targetCountryCodes", JSON.stringify(codes));
  }
  return formData;
}

test("country dataset contains unique ISO alpha-2 codes and excludes XK", () => {
  const codes = COUNTRY_OPTIONS.map(({ code }) => code);

  assert.equal(codes.length, 249);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(SUPPORTED_COUNTRY_CODES.has("US"), true);
  assert.equal(SUPPORTED_COUNTRY_CODES.has("AQ"), true);
  assert.equal(SUPPORTED_COUNTRY_CODES.has("XK"), false);
  assert.equal(SUPPORTED_COUNTRY_CODES.has("ZZ"), false);
});

test("country parser defaults to ALL and stores no country list for ALL", () => {
  assert.deepEqual(readCountryTargetingForm(new FormData()), {
    ok: true,
    data: {
      countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
      targetCountryCodes: [],
    },
  });

  assert.deepEqual(
    readCountryTargetingForm(
      countryForm(COUNTRY_TARGETING_MODES.ALL, ["US", "JP"]),
    ),
    {
      ok: true,
      data: {
        countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
        targetCountryCodes: [],
      },
    },
  );
});

test("country parser accepts one or multiple supported selections", () => {
  for (const codes of [["US"], ["CA", "JP"]]) {
    assert.deepEqual(
      readCountryTargetingForm(
        countryForm(COUNTRY_TARGETING_MODES.SELECTED, codes),
      ),
      {
        ok: true,
        data: {
          countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
          targetCountryCodes: codes,
        },
      },
    );
  }
});

test("country parser rejects invalid modes, codes, empty and duplicate selections", () => {
  for (const [mode, codes] of [
    ["MAYBE", ["US"]],
    [COUNTRY_TARGETING_MODES.SELECTED, []],
    [COUNTRY_TARGETING_MODES.SELECTED, ["us"]],
    [COUNTRY_TARGETING_MODES.SELECTED, ["XK"]],
    [COUNTRY_TARGETING_MODES.SELECTED, ["ZZ"]],
    [COUNTRY_TARGETING_MODES.SELECTED, ["US", "US"]],
    [COUNTRY_TARGETING_MODES.SELECTED, [1]],
  ]) {
    const result = readCountryTargetingForm(countryForm(mode, codes));
    assert.equal(result.ok, false, `${mode} ${JSON.stringify(codes)}`);
    assert.ok(result.error);
  }

  const malformed = new FormData();
  malformed.set("countryTargetingMode", COUNTRY_TARGETING_MODES.SELECTED);
  malformed.set("targetCountryCodes", "not-json");
  assert.equal(readCountryTargetingForm(malformed).ok, false);

  const duplicateMode = countryForm(COUNTRY_TARGETING_MODES.ALL, []);
  duplicateMode.append("countryTargetingMode", COUNTRY_TARGETING_MODES.ALL);
  assert.equal(readCountryTargetingForm(duplicateMode).ok, false);
});

test("legacy update submissions preserve saved countries while creates default to ALL", () => {
  const legacy = new FormData();
  const existing = {
    countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
    targetCountryCodes: ["GB", "CA"],
  };

  assert.deepEqual(readCountryTargetingForm(legacy, existing), {
    ok: true,
    data: existing,
  });
  assert.equal(readCountryTargetingForm(legacy).data.countryTargetingMode, "ALL");

  const partial = new FormData();
  partial.set("countryTargetingMode", COUNTRY_TARGETING_MODES.ALL);
  assert.equal(readCountryTargetingForm(partial, existing).ok, false);

  assert.deepEqual(
    readCountryTargetingForm(legacy, {
      countryTargetingMode: undefined,
      targetCountryCodes: undefined,
    }),
    {
      ok: true,
      data: {
        countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
        targetCountryCodes: [],
      },
    },
  );
});

test("country matcher requires an explicit resolved country and fails closed for unknown selections", () => {
  assert.equal(
    matchesCountryTargeting(
      {
        countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
        targetCountryCodes: [],
      },
      null,
    ),
    true,
  );
  assert.equal(
    matchesCountryTargeting(
      {
        countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
        targetCountryCodes: [],
      },
      "ZZ",
    ),
    true,
  );
  assert.equal(
    matchesCountryTargeting(
      {
        countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
        targetCountryCodes: ["US"],
      },
      "US",
    ),
    true,
  );
  for (const unknownCountry of [null, "ZZ", "XK"]) {
    assert.equal(
      matchesCountryTargeting(
        {
          countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
          targetCountryCodes: ["US"],
        },
        unknownCountry,
      ),
      false,
    );
  }
});

test("country search filters displayed choices without dropping hidden selections", () => {
  const selected = ["US"];
  const filtered = filterCountryOptions("japan");

  assert.deepEqual(filtered.map(({ code }) => code), ["JP"]);
  const withHiddenSelection = toggleCountryCode(selected, "JP", true);
  assert.deepEqual(withHiddenSelection, ["US", "JP"]);
  assert.deepEqual(toggleCountryCode(withHiddenSelection, "US", false), ["JP"]);
  assert.equal(toggleCountryCode(withHiddenSelection, "XX", true), withHiddenSelection);
  assert.deepEqual(filterCountryOptions("not a country"), []);
});

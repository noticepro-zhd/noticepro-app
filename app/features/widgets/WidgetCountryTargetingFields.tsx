import { useState } from "react";

import {
  COUNTRY_TARGETING_MODES,
  filterCountryOptions,
  toggleCountryCode,
  type CountryTargetingMode,
} from "./country-targeting.shared";

type Props = {
  initialValue?: {
    countryTargetingMode?: string | null;
    targetCountryCodes?: string[] | null;
  };
  error?: string;
};

export default function WidgetCountryTargetingFields({
  initialValue,
  error,
}: Props) {
  const [mode, setMode] = useState<CountryTargetingMode>(
    initialValue?.countryTargetingMode === COUNTRY_TARGETING_MODES.SELECTED
      ? COUNTRY_TARGETING_MODES.SELECTED
      : COUNTRY_TARGETING_MODES.ALL,
  );
  const [selectedCodes, setSelectedCodes] = useState<string[]>(
    () => [...(initialValue?.targetCountryCodes ?? [])],
  );
  const [search, setSearch] = useState("");

  const countries = filterCountryOptions(search);

  return (
    <div
      style={{
        display: "grid",
        gap: "12px",
        padding: "16px",
        border: "1px solid #d1d5db",
        borderRadius: "8px",
        minWidth: 0,
      }}
    >
      <label htmlFor="countryTargetingMode">Show by location</label>
      <select
        id="countryTargetingMode"
        name="countryTargetingMode"
        value={mode}
        aria-invalid={Boolean(error)}
        aria-describedby={`country-targeting-help${error ? " country-targeting-error" : ""}`}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (
            value === COUNTRY_TARGETING_MODES.ALL ||
            value === COUNTRY_TARGETING_MODES.SELECTED
          ) {
            setMode(value);
          }
        }}
        style={{ width: "100%", padding: "10px" }}
      >
        <option value={COUNTRY_TARGETING_MODES.ALL}>All countries</option>
        <option value={COUNTRY_TARGETING_MODES.SELECTED}>
          Selected countries
        </option>
      </select>

      <input
        type="hidden"
        name="targetCountryCodes"
        value={JSON.stringify(selectedCodes)}
      />

      <p id="country-targeting-help" style={{ margin: 0 }}>
        Country matching uses short-lived attestations from the configured
        Cloudflare Worker. While the integration is disabled, unavailable, or
        returns an unknown country, Selected countries rules will not match and
        can hide this widget. Keep All countries until the Worker is deployed,
        configured, and validated.
      </p>

      {mode === COUNTRY_TARGETING_MODES.SELECTED ? (
        <fieldset
          style={{
            display: "grid",
            gap: "12px",
            maxHeight: "360px",
            overflowY: "auto",
            padding: "12px",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            minWidth: 0,
          }}
        >
          <legend>Select countries</legend>
          <label htmlFor="countryTargetingSearch">Search countries</label>
          <input
            id="countryTargetingSearch"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            autoComplete="off"
          />
          <p aria-live="polite" style={{ margin: 0 }}>
            {selectedCodes.length} {selectedCodes.length === 1 ? "country" : "countries"}{" "}
            selected
          </p>
          <div
            role="group"
            aria-label="Country options"
            style={{ display: "grid", gap: "8px" }}
          >
            {countries.map(({ code, name }) => (
              <label key={code}>
                <input
                  type="checkbox"
                  checked={selectedCodes.includes(code)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedCodes((current) =>
                      toggleCountryCode(current, code, checked),
                    );
                  }}
                />{" "}
                {name}
              </label>
            ))}
            {countries.length === 0 ? (
              <p role="status" style={{ margin: 0 }}>
                No countries match your search.
              </p>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p
          id="country-targeting-error"
          role="alert"
          style={{ margin: 0, color: "#b42318" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

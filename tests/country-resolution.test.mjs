import assert from "node:assert/strict";
import test from "node:test";

import { resolveVisitorCountry } from "../app/features/widgets/country-resolution.server.ts";
import { getTrustedVisitorIp } from "../app/features/widgets/trusted-visitor-ip.server.ts";

test("production country resolver ignores IP/country headers and query values", async () => {
  const request = new Request(
    "https://shop.test/apps/notice-pro?country=US&country_code=CA&ip=198.51.100.10&locale=en-US",
    {
      headers: {
        "x-forwarded-for": "198.51.100.11",
        "x-real-ip": "198.51.100.12",
        "cf-connecting-ip": "198.51.100.13",
        "cf-ipcountry": "JP",
        "x-geo-country": "AU",
        "accept-language": "en-US",
      },
    },
  );

  assert.equal(getTrustedVisitorIp(request), null);
  assert.equal(await resolveVisitorCountry(request, "shop.test"), null);
});

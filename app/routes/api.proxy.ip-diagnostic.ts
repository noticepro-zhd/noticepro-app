import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  isCountryDatabaseReady,
  lookupCountryForIp,
} from "../features/widgets/country-database.server";
import {
  createCountryIpDiagnosticRateLimiter,
  inspectForwardedFor,
  readCountryIpDiagnosticConfig,
} from "../features/widgets/country-ip-diagnostic.server";

const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const rateLimiter = createCountryIpDiagnosticRateLimiter();

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return Response.json(
      { error: "App proxy authentication required." },
      { status: 401, headers: responseHeaders },
    );
  }

  const config = readCountryIpDiagnosticConfig();
  if (!config || session.shop.toLowerCase() !== config.shop) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  if (!rateLimiter.allow(config.shop)) {
    return Response.json(
      { error: "Diagnostic rate limit reached." },
      { status: 429, headers: responseHeaders },
    );
  }

  const geoLiteReady = isCountryDatabaseReady();
  const forwardedFor = await inspectForwardedFor(
    request.headers.get("x-forwarded-for"),
    config.expectedCountry,
    lookupCountryForIp,
  );

  return Response.json(
    {
      headerTrust: "unverified",
      geoLiteReady,
      forwardedFor,
    },
    { headers: responseHeaders },
  );
}

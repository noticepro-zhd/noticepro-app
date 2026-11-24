import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  createCountryIpDiagnosticRateLimiter,
  inspectForwardedFor,
  isOperatorDiagnosticShop,
  readCountryIpDiagnosticConfig,
} from "../features/widgets/country-ip-diagnostic.server";

const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const rateLimiter = createCountryIpDiagnosticRateLimiter();

function authFailure(status = 401) {
  return Response.json(
    { error: "App proxy authentication required." },
    { status, headers: responseHeaders },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const config = readCountryIpDiagnosticConfig();
  if (!config) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  let session: { shop: string } | undefined;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch (error) {
    return authFailure(error instanceof Response ? 401 : 503);
  }

  if (!session) return authFailure();

  if (!isOperatorDiagnosticShop(session.shop)) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  if (!rateLimiter.allow()) {
    return Response.json(
      { error: "Diagnostic rate limit reached." },
      { status: 429, headers: responseHeaders },
    );
  }

  return Response.json(
    {
      headerTrust: "unverified",
      countryVerdicts: "unavailable",
      forwardedFor: inspectForwardedFor(
        request.headers.get("x-forwarded-for"),
      ),
    },
    { headers: responseHeaders },
  );
}

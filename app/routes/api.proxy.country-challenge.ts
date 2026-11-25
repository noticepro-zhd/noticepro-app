import type { LoaderFunctionArgs } from "react-router";

import {
  issueCountryChallenge,
  readCountryAttestationConfiguration,
} from "../features/widgets/country-attestation.server";
import { authenticate } from "../shopify.server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);

  if (!session || !admin) {
    return Response.json(
      { error: "App proxy session unavailable" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const configuration = readCountryAttestationConfiguration();
  if (
    !configuration.enabled ||
    !configuration.secret ||
    !configuration.workerUrl
  ) {
    return Response.json(
      { error: "Country resolution unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  return Response.json(
    {
      challenge: issueCountryChallenge(session.shop, configuration.secret),
      workerUrl: configuration.workerUrl,
    },
    { headers: NO_STORE_HEADERS },
  );
}

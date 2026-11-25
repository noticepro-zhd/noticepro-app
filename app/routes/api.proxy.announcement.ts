import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  WIDGET_STATUSES,
  WIDGET_TYPES,
} from "../features/widgets/widget.constants";
import { widgetScope } from "../features/widgets/widget.server";
import { getStorefrontWidgetLimit } from "../features/billing/storefront-plan.server";
import { authenticate } from "../shopify.server";
import {
  matchesTargeting,
  readTargetingContext,
} from "../features/widgets/targeting.shared";
import { getCachedMatchingCollectionIds } from "../features/widgets/targeting.server";
import {
  boundCountryAttestationRequest,
  resolveVisitorCountry,
} from "../features/widgets/country-resolution.server";
import { filterByCountryTargeting } from "../features/widgets/country-targeting.server";

async function respond(request: Request) {
  const { session, admin } = await authenticate.public.appProxy(request);
  const headers = { "Cache-Control": "no-store" };

  if (!session || !admin) {
    return Response.json(
      { error: "App proxy session unavailable" },
      { status: 401, headers },
    );
  }

  const countryAssertionRequest = await boundCountryAttestationRequest(
    request,
  );
  const now = new Date();

  const eligibleAnnouncements = await db.widget.findMany({
    where: {
      ...widgetScope(session.shop, WIDGET_TYPES.ANNOUNCEMENT),
      status: WIDGET_STATUSES.ACTIVE,
      AND: [
        {
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        },
        {
          OR: [{ endsAt: null }, { endsAt: { gte: now } }],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      targetingMode: true,
      targetProductIds: true,
      targetCollectionIds: true,
      countryTargetingMode: true,
      targetCountryCodes: true,
      id: true,
      message: true,
      buttonText: true,
      buttonUrl: true,
      position: true,
      backgroundColor: true,
      textColor: true,
      dismissible: true,
    },
  });

  const context = readTargetingContext(new URL(request.url));

  if (context.pageType === "product" && context.productId !== null) {
    const candidateCollectionIds = eligibleAnnouncements.flatMap(
      (announcement) =>
        announcement.targetingMode === "COLLECTIONS"
          ? announcement.targetCollectionIds
          : [],
    );

    const matchingCollectionIds = await getCachedMatchingCollectionIds(
      session.shop,
      admin,
      context.productId,
      candidateCollectionIds,
    );

    context.collectionIds = matchingCollectionIds ?? [];
  }

  const pageEligibleAnnouncements = eligibleAnnouncements.filter(
    (announcement) => {
      const mode = announcement.targetingMode;

      if (mode !== "ALL" && mode !== "PRODUCTS" && mode !== "COLLECTIONS") {
        return false;
      }

      return matchesTargeting(
        {
          targetingMode: mode,
          targetProductIds: announcement.targetProductIds,
          targetCollectionIds: announcement.targetCollectionIds,
        },
        context,
      );
    },
  );
  const matchingAnnouncements = await filterByCountryTargeting(
    pageEligibleAnnouncements,
    countryAssertionRequest,
    session.shop,
    resolveVisitorCountry,
  );

  // Keep targeting configuration out of the public response.
  let announcements = matchingAnnouncements.map((announcement) => ({
    id: announcement.id,
    message: announcement.message,
    buttonText: announcement.buttonText,
    buttonUrl: announcement.buttonUrl,
    position: announcement.position,
    backgroundColor: announcement.backgroundColor,
    textColor: announcement.textColor,
    dismissible: announcement.dismissible,
  }));

  // Apply the display allowance after page and country targeting.
  if (announcements.length > 1) {
    const limit = await getStorefrontWidgetLimit(admin, session.shop);

    if (limit !== null) {
      announcements = announcements.slice(0, limit);
    }
  }
  const multiFormat =
    new URL(request.url).searchParams.get("format") === "multi";

  return Response.json(
    multiFormat ? { announcements } : (announcements[0] ?? null),
    { headers },
  );
}

export function loader({ request }: LoaderFunctionArgs) {
  return respond(request);
}

export function action({ request }: ActionFunctionArgs) {
  return respond(request);
}

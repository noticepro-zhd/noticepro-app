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

  const eligibleNotices = await db.widget.findMany({
    where: {
      ...widgetScope(session.shop, WIDGET_TYPES.NOTICE),
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
      backgroundColor: true,
      textColor: true,
      dismissible: true,
    },
  });

  const context = readTargetingContext(new URL(request.url));

  if (context.pageType === "product" && context.productId !== null) {
    const candidateCollectionIds = eligibleNotices.flatMap((notice) =>
      notice.targetingMode === "COLLECTIONS" ? notice.targetCollectionIds : [],
    );

    const matchingCollectionIds = await getCachedMatchingCollectionIds(
      session.shop,
      admin,
      context.productId,
      candidateCollectionIds,
    );

    // A failed lookup must not imply collection membership.
    // ALL and directly targeted product notices can still match.
    context.collectionIds = matchingCollectionIds ?? [];
  }

  const pageEligibleNotices = eligibleNotices.filter((notice) => {
    const mode = notice.targetingMode;

    if (mode !== "ALL" && mode !== "PRODUCTS" && mode !== "COLLECTIONS") {
      return false;
    }

    return matchesTargeting(
      {
        targetingMode: mode,
        targetProductIds: notice.targetProductIds,
        targetCollectionIds: notice.targetCollectionIds,
      },
      context,
    );
  });
  const matchingNotices = await filterByCountryTargeting(
    pageEligibleNotices,
    countryAssertionRequest,
    session.shop,
    resolveVisitorCountry,
  );

  // Return public widget content only, not targeting configuration.
  let notices = matchingNotices.map((notice) => ({
    id: notice.id,
    message: notice.message,
    buttonText: notice.buttonText,
    buttonUrl: notice.buttonUrl,
    backgroundColor: notice.backgroundColor,
    textColor: notice.textColor,
    dismissible: notice.dismissible,
  }));

  // Apply the display allowance after page and country targeting.
  if (notices.length > 1) {
    const limit = await getStorefrontWidgetLimit(admin, session.shop);

    if (limit !== null) {
      notices = notices.slice(0, limit);
    }
  }

  const multiFormat =
    new URL(request.url).searchParams.get("format") === "multi";

  return Response.json(multiFormat ? { notices } : (notices[0] ?? null), {
    headers,
  });
}

export function loader({ request }: LoaderFunctionArgs) {
  return respond(request);
}

export function action({ request }: ActionFunctionArgs) {
  return respond(request);
}

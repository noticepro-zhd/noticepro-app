import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  WIDGET_STATUSES,
  WIDGET_TYPES,
} from "../features/widgets/widget.constants";
import { widgetScope } from "../features/widgets/widget.server";
import { getStorefrontWidgetLimit } from "../features/billing/storefront-plan.server";

import {
  matchesTargeting,
  readTargetingContext,
} from "../features/widgets/targeting.shared";
import { getCachedMatchingCollectionIds } from "../features/widgets/targeting.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  const headers = { "Cache-Control": "no-store" };

  if (!session || !admin) {
    return Response.json(
      { error: "App proxy session unavailable" },
      { status: 401, headers },
    );
  }

  const now = new Date();

  const eligibleCountdowns = await db.widget.findMany({
    where: {
      ...widgetScope(session.shop, WIDGET_TYPES.COUNTDOWN),
      status: WIDGET_STATUSES.ACTIVE,
      countdownEndsAt: { not: null },
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
      id: true,
      message: true,
      backgroundColor: true,
      textColor: true,
      countdownEndsAt: true,
      countdownShowDays: true,
      countdownSticky: true,
      countdownDesktopOffset: true,
      countdownMobileOffset: true,
      countdownExpiredText: true,
    },
  });

  const context = readTargetingContext(new URL(request.url));

  if (context.pageType === "product" && context.productId !== null) {
    const candidateCollectionIds = eligibleCountdowns.flatMap((countdown) =>
      countdown.targetingMode === "COLLECTIONS"
        ? countdown.targetCollectionIds
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

  const matchingCountdowns = eligibleCountdowns.filter((countdown) => {
    const mode = countdown.targetingMode;

    if (mode !== "ALL" && mode !== "PRODUCTS" && mode !== "COLLECTIONS") {
      return false;
    }

    return matchesTargeting(
      {
        targetingMode: mode,
        targetProductIds: countdown.targetProductIds,
        targetCollectionIds: countdown.targetCollectionIds,
      },
      context,
    );
  });

  // Keep targeting configuration out of the public response.
  let countdowns = matchingCountdowns.map((countdown) => ({
    id: countdown.id,
    message: countdown.message,
    backgroundColor: countdown.backgroundColor,
    textColor: countdown.textColor,
    countdownEndsAt: countdown.countdownEndsAt,
    countdownShowDays: countdown.countdownShowDays,
    countdownSticky: countdown.countdownSticky,
    countdownDesktopOffset: countdown.countdownDesktopOffset,
    countdownMobileOffset: countdown.countdownMobileOffset,
    countdownExpiredText: countdown.countdownExpiredText,
  }));

  // Apply the display allowance after page matching.
  if (countdowns.length > 1) {
    const limit = await getStorefrontWidgetLimit(admin, session.shop);

    if (limit !== null) {
      countdowns = countdowns.slice(0, limit);
    }
  }

  const multiFormat =
    new URL(request.url).searchParams.get("format") === "multi";

  const serverNow = new Date().toISOString();

  return Response.json(
    multiFormat
      ? { countdowns, serverNow }
      : { countdown: countdowns[0] ?? null, serverNow },
    { headers },
  );
}

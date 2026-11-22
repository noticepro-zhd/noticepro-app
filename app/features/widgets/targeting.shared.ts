export type TargetingMode = "ALL" | "PRODUCTS" | "COLLECTIONS";

export type WidgetTargeting = {
  targetingMode: TargetingMode;
  targetProductIds: string[];
  targetCollectionIds: string[];
};

export type TargetingContext = {
  pageType: "product" | "collection" | "other";
  productId: string | null;
  collectionIds: string[];
};

type TargetingResult =
  { ok: true; data: WidgetTargeting } | { ok: false; error: string };

const MAX_SELECTIONS = 50;

function readIds(
  entry: FormDataEntryValue | null,
  resource: "Product" | "Collection",
): string[] | null {
  if (entry === null) return [];
  if (typeof entry !== "string") return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(entry);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length > MAX_SELECTIONS) {
    return null;
  }

  const pattern = new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`);
  const ids: string[] = [];

  for (const value of parsed) {
    if (typeof value !== "string" || !pattern.test(value)) {
      return null;
    }

    ids.push(value);
  }

  return [...new Set(ids)];
}

export function readTargetingForm(formData: FormData): TargetingResult {
  const mode = formData.get("targetingMode");

  if (mode !== "ALL" && mode !== "PRODUCTS" && mode !== "COLLECTIONS") {
    return { ok: false, error: "Please choose a valid targeting option." };
  }

  if (mode === "ALL") {
    return {
      ok: true,
      data: {
        targetingMode: "ALL",
        targetProductIds: [],
        targetCollectionIds: [],
      },
    };
  }

  const isProducts = mode === "PRODUCTS";
  const ids = readIds(
    formData.get(isProducts ? "targetProductIds" : "targetCollectionIds"),
    isProducts ? "Product" : "Collection",
  );

  if (ids === null || ids.length === 0) {
    return {
      ok: false,
      error: `Select between 1 and ${MAX_SELECTIONS} valid ${
        isProducts ? "products" : "collections"
      }.`,
    };
  }

  return {
    ok: true,
    data: {
      targetingMode: mode,
      targetProductIds: isProducts ? ids : [],
      targetCollectionIds: isProducts ? [] : ids,
    },
  };
}

export function matchesTargeting(
  targeting: WidgetTargeting,
  context: TargetingContext,
): boolean {
  if (targeting.targetingMode === "ALL") {
    return true;
  }

  if (targeting.targetingMode === "PRODUCTS") {
    return (
      context.pageType === "product" &&
      context.productId !== null &&
      targeting.targetProductIds.includes(context.productId)
    );
  }

  if (targeting.targetingMode === "COLLECTIONS") {
    return (
      (context.pageType === "product" || context.pageType === "collection") &&
      context.collectionIds.some((id) =>
        targeting.targetCollectionIds.includes(id),
      )
    );
  }

  // Unknown modes must not accidentally display everywhere.
  return false;
}

export function readTargetingContext(url: URL): TargetingContext {
  const fallback: TargetingContext = {
    pageType: "other",
    productId: null,
    collectionIds: [],
  };

  const params = url.searchParams;
  const keys = ["np_page", "np_product", "np_collection"];

  // Reject ambiguous context instead of choosing between duplicate values.
  if (keys.some((key) => params.getAll(key).length > 1)) {
    return fallback;
  }

  const pageType = params.get("np_page");
  const numericId = /^[1-9][0-9]*$/;

  if (pageType === "product") {
    const id = params.get("np_product");

    if (
      !id ||
      !numericId.test(id) ||
      params.has("np_collection")
    ) {
      return fallback;
    }

    return {
      pageType: "product",
      productId: `gid://shopify/Product/${id}`,
      // Membership will be resolved separately on the server.
      collectionIds: [],
    };
  }

  if (pageType === "collection") {
    const id = params.get("np_collection");

    if (
      !id ||
      !numericId.test(id) ||
      params.has("np_product")
    ) {
      return fallback;
    }

    return {
      pageType: "collection",
      productId: null,
      collectionIds: [`gid://shopify/Collection/${id}`],
    };
  }

  if (pageType !== "other") return fallback;

  // Other-page context must not carry resource identity parameters.
  if (params.has("np_product") || params.has("np_collection")) {
    return fallback;
  }

  return fallback;
}

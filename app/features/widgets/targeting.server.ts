import type { authenticate } from "../../shopify.server";
import type { WidgetTargeting } from "./targeting.shared";

type AuthenticatedAdmin = Awaited<
  ReturnType<typeof authenticate.admin>
>["admin"];

type VerificationResult = { ok: true } | { ok: false; error: string };
// One deadline covers GraphQL request, JSON parsing, and every batch.
const MEMBERSHIP_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function verifyTargetingSelection(
  admin: AuthenticatedAdmin,
  targeting: WidgetTargeting,
): Promise<VerificationResult> {
  if (targeting.targetingMode === "ALL") {
    return { ok: true };
  }

  const expectedType =
    targeting.targetingMode === "PRODUCTS" ? "Product" : "Collection";

  const ids =
    targeting.targetingMode === "PRODUCTS"
      ? targeting.targetProductIds
      : targeting.targetCollectionIds;

  if (
    (targeting.targetingMode !== "PRODUCTS" &&
      targeting.targetingMode !== "COLLECTIONS") ||
    ids.length === 0 ||
    ids.length > 50
  ) {
    return {
      ok: false,
      error: "Please choose a valid targeting selection.",
    };
  }

  try {
    const response = await admin.graphql(
      `#graphql
        query NoticeProVerifyTargeting($ids: [ID!]!) {
          nodes(ids: $ids) {
            __typename
            ... on Product {
              id
            }
            ... on Collection {
              id
            }
          }
        }
      `,
      { variables: { ids } },
    );

    const payload: unknown = await response.json();

    if (
      !isRecord(payload) ||
      ("errors" in payload &&
        (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
      !isRecord(payload.data) ||
      !Array.isArray(payload.data.nodes)
    ) {
      throw new Error("Targeting verification unavailable");
    }

    const nodes = payload.data.nodes;

    if (nodes.length !== ids.length) {
      throw new Error("Incomplete targeting verification");
    }

    const verifiedIds = new Set<string>();

    for (const node of nodes) {
      if (
        !isRecord(node) ||
        node.__typename !== expectedType ||
        typeof node.id !== "string" ||
        !ids.includes(node.id)
      ) {
        return {
          ok: false,
          error:
            "One or more selected items are unavailable. Reopen the selector and choose items from this store.",
        };
      }

      verifiedIds.add(node.id);
    }

    if (verifiedIds.size !== ids.length) {
      throw new Error("Incomplete targeting verification");
    }

    return { ok: true };
  } catch {
    // Do not expose API errors, tokens, or store data.
    return {
      ok: false,
      error:
        "We could not verify the selected items. Check app permissions and try again.",
    };
  }
}
export async function getMatchingCollectionIds(
  admin: AuthenticatedAdmin,
  productId: string,
  collectionIds: string[],
): Promise<string[] | null> {
  const ids = [...new Set(collectionIds)];

  if (ids.length === 0) return [];

  if (
    !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(productId) ||
    ids.some((id) => !/^gid:\/\/shopify\/Collection\/[1-9][0-9]*$/.test(id))
  ) {
    return null;
  }

  const matches = new Set<string>();
  const controller = new AbortController();
  const deadline = Date.now() + MEMBERSHIP_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    timeoutHandle = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);

    // Installed Admin GraphQL types support AbortSignal. JSON parsing remains
    // non-cancellable, so timeout rejection only stops waiting for it.
    // Check only the collections referenced by eligible widget rules.
    for (let offset = 0; offset < ids.length; offset += 50) {
      if (Date.now() >= deadline) {
        controller.abort();
        throw new Error("Collection membership timed out");
      }

      const batch = ids.slice(offset, offset + 50);

      const request = admin.graphql(
        `#graphql
          query NoticeProCollectionMembership(
            $ids: [ID!]!
            $productId: ID!
          ) {
            nodes(ids: $ids) {
              __typename
              ... on Collection {
                id
                hasProduct(id: $productId)
              }
            }
          }
        `,
        {
          variables: {
            ids: batch,
            productId,
          },
          signal: controller.signal,
        },
      );
      // Attach rejection handling before any Date.now/deadline branch. This
      // prevents a started request that rejects while a deadline branch is
      // taken from becoming an unhandled rejection.
      request.catch(() => {});

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        controller.abort();
        throw new Error("Collection membership timed out");
      }

      let requestTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const response = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          requestTimeoutHandle = setTimeout(
            () => reject(new Error("Collection membership timed out")),
            remainingMs,
          );
        }),
      ]).finally(() => {
        if (requestTimeoutHandle !== null) {
          clearTimeout(requestTimeoutHandle);
        }
      });

      const jsonRemainingMs = deadline - Date.now();
      if (jsonRemainingMs <= 0) {
        controller.abort();
        throw new Error("Collection membership response timed out");
      }

      const jsonPromise = response.json();
      jsonPromise.catch(() => {});
      let jsonTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const payload: unknown = await Promise.race([
        jsonPromise,
        new Promise<never>((_, reject) => {
          jsonTimeoutHandle = setTimeout(
            () => reject(new Error("Collection membership response timed out")),
            jsonRemainingMs,
          );
        }),
      ]).finally(() => {
        if (jsonTimeoutHandle !== null) {
          clearTimeout(jsonTimeoutHandle);
        }
      });

      if (
        !isRecord(payload) ||
        ("errors" in payload &&
          (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
        !isRecord(payload.data) ||
        !Array.isArray(payload.data.nodes) ||
        payload.data.nodes.length !== batch.length
      ) {
        throw new Error("Collection membership unavailable");
      }

      const returnedIds = new Set<string>();

      for (const node of payload.data.nodes) {
        // Deleted or unavailable collections cannot match.
        if (node === null) continue;

        if (
          !isRecord(node) ||
          node.__typename !== "Collection" ||
          typeof node.id !== "string" ||
          !batch.includes(node.id) ||
          typeof node.hasProduct !== "boolean" ||
          returnedIds.has(node.id)
        ) {
          throw new Error("Invalid collection membership response");
        }

        returnedIds.add(node.id);

        if (node.hasProduct) {
          matches.add(node.id);
        }
      }
    }

    return [...matches];
  } catch {
    // Never treat an API/permission failure as confirmed membership.
    controller.abort();
    return null;
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

type MembershipCacheEntry = {
  expiresAt: number;
  promise: Promise<string[] | null>;
  keyLength: number;
  idCount: number;
};

const membershipCache = new Map<string, MembershipCacheEntry>();

const MEMBERSHIP_SUCCESS_TTL = 30_000;
const MEMBERSHIP_FAILURE_TTL = 5_000;
const MEMBERSHIP_CACHE_MAX = 500;
const MEMBERSHIP_MAX_KEY_LENGTH = 32_000;
const MEMBERSHIP_MAX_CACHED_IDS = 25_000;
// This is a bounded process-local cache only, not a global Shopify rate limiter.

export function resetMembershipCacheForTests(): void {
  membershipCache.clear();
}

export async function getCachedMatchingCollectionIds(
  shopDomain: string,
  admin: AuthenticatedAdmin,
  productId: string,
  collectionIds: string[],
): Promise<string[] | null> {
  const ids = [...new Set(collectionIds)].sort();

  if (ids.length === 0) return [];

  const key = JSON.stringify([shopDomain, productId, ids]);
  const now = Date.now();

  const existing = membershipCache.get(key);

  if (existing && existing.expiresAt > now) {
    const result = await existing.promise;
    return result === null ? null : [...result];
  }

  if (existing) {
    membershipCache.delete(key);
  }

  // Remove expired settled entries. In-flight entries have Infinity expiry.
  for (const [cachedKey, entry] of membershipCache) {
    if (entry.expiresAt !== Infinity && entry.expiresAt <= now) {
      membershipCache.delete(cachedKey);
    }
  }

  // Oversized keys and aggregate cached API work are not sent to uncached,
  // unlimited API lookup: return an unconfirmed result conservatively.
  if (
    key.length > MEMBERSHIP_MAX_KEY_LENGTH ||
    ids.length > MEMBERSHIP_MAX_CACHED_IDS
  ) {
    return null;
  }

  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX) {
    let evictedSettledKey: string | undefined;
    for (const [cachedKey, entry] of membershipCache) {
      if (entry.expiresAt !== Infinity) {
        evictedSettledKey = cachedKey;
        break;
      }
    }

    if (evictedSettledKey !== undefined) {
      membershipCache.delete(evictedSettledKey);
    } else {
      // Capacity is entirely pending. Do not evict pending work or launch a
      // duplicate request for a cache miss.
      return null;
    }
  }

  const totalCachedIds = [...membershipCache.values()].reduce(
    (total, entry) => total + entry.idCount,
    0,
  );
  if (totalCachedIds + ids.length > MEMBERSHIP_MAX_CACHED_IDS) {
    // Capacity is capped by both entry count and total membership API work.
    // Eviction still never touches pending entries.
    for (const [cachedKey, entry] of membershipCache) {
      if (entry.expiresAt !== Infinity) {
        membershipCache.delete(cachedKey);
        if (
          [...membershipCache.values()].reduce(
            (total, cachedEntry) => total + cachedEntry.idCount,
            0,
          ) +
            ids.length <=
          MEMBERSHIP_MAX_CACHED_IDS
        ) {
          break;
        }
      }
    }
  }

  const finalTotalCachedIds = [...membershipCache.values()].reduce(
    (total, entry) => total + entry.idCount,
    0,
  );
  if (finalTotalCachedIds + ids.length > MEMBERSHIP_MAX_CACHED_IDS) {
    return null;
  }

  const entry: MembershipCacheEntry = {
    expiresAt: Infinity,
    promise: Promise.resolve(null),
    keyLength: key.length,
    idCount: ids.length,
  };

  entry.promise = getMatchingCollectionIds(admin, productId, ids)
    .then((result) => {
      entry.expiresAt =
        Date.now() +
        (result === null ? MEMBERSHIP_FAILURE_TTL : MEMBERSHIP_SUCCESS_TTL);

      return result === null ? null : [...result];
    })
    .catch(() => {
      entry.expiresAt = Date.now() + MEMBERSHIP_FAILURE_TTL;
      return null;
    });

  membershipCache.set(key, entry);

  const result = await entry.promise;
  return result === null ? null : [...result];
}

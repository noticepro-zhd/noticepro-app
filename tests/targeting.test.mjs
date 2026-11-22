import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesTargeting,
  readTargetingContext,
  readTargetingForm,
} from "../app/features/widgets/targeting.shared.ts";
import {
  getCachedMatchingCollectionIds,
  getMatchingCollectionIds,
  resetMembershipCacheForTests,
  verifyTargetingSelection,
} from "../app/features/widgets/targeting.server.ts";
import {
  activeWidgetLimitForPlan,
  canActivateAnotherWidget,
} from "../app/features/billing/plan-policy.server.ts";

function form(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

test("ALL compatibility clears both selections", () => {
  const result = readTargetingForm(
    form({
      targetingMode: "ALL",
      targetProductIds: JSON.stringify(["gid://shopify/Product/1"]),
      targetCollectionIds: JSON.stringify(["gid://shopify/Collection/2"]),
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    data: {
      targetingMode: "ALL",
      targetProductIds: [],
      targetCollectionIds: [],
    },
  });
});

test("targeted forms validate, deduplicate, and clear irrelevant arrays", () => {
  const products = readTargetingForm(
    form({
      targetingMode: "PRODUCTS",
      targetProductIds: JSON.stringify([
        "gid://shopify/Product/1",
        "gid://shopify/Product/1",
        "gid://shopify/Product/9007199254740993",
      ]),
      targetCollectionIds: JSON.stringify(["gid://shopify/Collection/99"]),
    }),
  );
  assert.equal(products.ok, true);
  assert.equal(products.data.targetProductIds.length, 2);
  assert.deepEqual(products.data.targetCollectionIds, []);

  const collections = readTargetingForm(
    form({
      targetingMode: "COLLECTIONS",
      targetCollectionIds: JSON.stringify([
        "gid://shopify/Collection/2",
        "gid://shopify/Collection/2",
      ]),
    }),
  );
  assert.equal(collections.ok, true);
  assert.deepEqual(collections.data.targetProductIds, []);
});

test("invalid and empty targeted selections do not broaden to ALL", () => {
  for (const entries of [
    { targetingMode: "PRODUCTS", targetProductIds: "[]" },
    { targetingMode: "COLLECTIONS", targetCollectionIds: "not-json" },
    {
      targetingMode: "PRODUCTS",
      targetProductIds: JSON.stringify(["gid://shopify/Collection/1"]),
    },
    {
      targetingMode: "COLLECTIONS",
      targetCollectionIds: JSON.stringify(["gid://shopify/Collection/0"]),
    },
    { targetingMode: "UNKNOWN" },
  ]) {
    assert.equal(readTargetingForm(form(entries)).ok, false);
  }
});

test("selection count is limited to 50", () => {
  const ids = Array.from(
    { length: 51 },
    (_, index) => `gid://shopify/Product/${index + 1}`,
  );
  assert.equal(
    readTargetingForm(
      form({
        targetingMode: "PRODUCTS",
        targetProductIds: JSON.stringify(ids),
      }),
    ).ok,
    false,
  );
});

test("matching covers ALL, product, collection, and unknown modes", () => {
  const all = {
    targetingMode: "ALL",
    targetProductIds: [],
    targetCollectionIds: [],
  };
  const product = {
    targetingMode: "PRODUCTS",
    targetProductIds: ["gid://shopify/Product/9007199254740993"],
    targetCollectionIds: [],
  };
  const collection = {
    targetingMode: "COLLECTIONS",
    targetProductIds: [],
    targetCollectionIds: ["gid://shopify/Collection/42"],
  };

  const other = { pageType: "other", productId: null, collectionIds: [] };
  const productPage = {
    pageType: "product",
    productId: "gid://shopify/Product/9007199254740993",
    collectionIds: [],
  };
  const collectionPage = {
    pageType: "collection",
    productId: null,
    collectionIds: ["gid://shopify/Collection/42"],
  };
  assert.equal(matchesTargeting(all, other), true);
  assert.equal(matchesTargeting(product, productPage), true);
  assert.equal(matchesTargeting(product, other), false);
  assert.equal(matchesTargeting(collection, collectionPage), true);
  assert.equal(
    matchesTargeting({ ...collection, targetingMode: "MYSTERY" }, collectionPage),
    false,
  );
});

test("context parsing preserves precision and rejects malformed or duplicate context", () => {
  assert.deepEqual(
    readTargetingContext(
      new URL(
        "https://shop.test/products/a?np_page=product&np_product=9007199254740993",
      ),
    ),
    {
      pageType: "product",
      productId: "gid://shopify/Product/9007199254740993",
      collectionIds: [],
    },
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=product&np_product=0"),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL(
        "https://shop.test/a?np_page=product&np_product=1&np_product=2",
      ),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL(
        "https://shop.test/a?np_page=collection&np_collection=2&np_collection=3",
      ),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=other&np_product=1"),
    ).pageType,
    "other",
  );
});

test("collection context matching plain product URLs is resolved server-side", () => {
  const context = readTargetingContext(
    new URL("https://shop.test/products/a?np_page=product&np_product=7"),
  );
  assert.equal(context.pageType, "product");
  assert.deepEqual(context.collectionIds, []);
});

test("resource verifier accepts exact nodes and rejects failures", async () => {
  const ids = ["gid://shopify/Product/1", "gid://shopify/Product/2"];
  const okAdmin = {
    async graphql() {
      return {
        async json() {
          return {
            data: {
              nodes: [
                { __typename: "Product", id: ids[0] },
                { __typename: "Product", id: ids[1] },
              ],
            },
          };
        },
      };
    },
  };
  assert.equal(
    (
      await verifyTargetingSelection(okAdmin, {
        targetingMode: "PRODUCTS",
        targetProductIds: ids,
        targetCollectionIds: [],
      })
    ).ok,
    true,
  );

  for (const payload of [
    { data: { nodes: [] } },
    { data: { nodes: [{ __typename: "Collection", id: ids[0] }] } },
    { errors: [{ message: "failed" }], data: { nodes: [] } },
  ]) {
    const failAdmin = {
      async graphql() {
        return { async json() { return payload; } };
      },
    };
    assert.equal(
      (
        await verifyTargetingSelection(failAdmin, {
          targetingMode: "PRODUCTS",
          targetProductIds: ids,
          targetCollectionIds: [],
        })
      ).ok,
      false,
    );
  }
});

test("collection membership succeeds, rejects deleted nodes, and batches 50", async () => {
  let calls = 0;
  const admin = {
    async graphql(_query, { variables }) {
      calls += 1;
      return {
        async json() {
          return {
            data: {
              nodes: variables.ids.map((id, index) => ({
                __typename: "Collection",
                id,
                hasProduct: index % 2 === 0,
              })),
            },
          };
        },
      };
    },
  };
  const collectionIds = Array.from(
    { length: 51 },
    (_, index) => `gid://shopify/Collection/${index + 1}`,
  );
  const matches = await getMatchingCollectionIds(
    admin,
    "gid://shopify/Product/7",
    collectionIds,
  );
  assert.equal(calls, 2);
  assert.equal(matches.length, 26);

  const deletedAdmin = {
    async graphql() {
      return {
        async json() {
          return { data: { nodes: [null] } };
        },
      };
    },
  };
  assert.equal(
    await getMatchingCollectionIds(
      deletedAdmin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    ).then((value) => value?.length),
    0,
  );
});

test("collection membership failures and invalid shapes fail closed", async () => {
  const admin = {
    async graphql() {
      return { async json() { return { errors: [{ message: "no scope" }] }; } };
    },
  };
  assert.equal(
    await getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    ),
    null,
  );
  assert.equal(
    await getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/not-valid"],
    ),
    null,
  );
});

test("collection membership rejects partial API errors and malformed or duplicate nodes", async () => {
  const productId = "gid://shopify/Product/7";
  const ids = [
    "gid://shopify/Collection/1",
    "gid://shopify/Collection/2",
  ];

  for (const payload of [
    { data: { nodes: [{ __typename: "Collection", id: ids[0], hasProduct: true }] } },
    { data: { nodes: [
      { __typename: "Collection", id: ids[0], hasProduct: true },
      { __typename: "Collection", id: ids[0], hasProduct: false },
    ] } },
    { errors: [{ message: "partial" }], data: { nodes: [] } },
  ]) {
    const admin = {
      async graphql() {
        return { async json() { return payload; } };
      },
    };
    assert.equal(await getMatchingCollectionIds(admin, productId, ids), null);
  }
});

test("mixed deleted collection nodes preserve valid matches and all-null responses", async () => {
  const cases = [
    {
      ids: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
      nodes: [
        null,
        {
          __typename: "Collection",
          id: "gid://shopify/Collection/2",
          hasProduct: true,
        },
      ],
      expected: ["gid://shopify/Collection/2"],
    },
    {
      ids: ["gid://shopify/Collection/1", "gid://shopify/Collection/2", "gid://shopify/Collection/3"],
      nodes: [
        {
          __typename: "Collection",
          id: "gid://shopify/Collection/1",
          hasProduct: false,
        },
        null,
        {
          __typename: "Collection",
          id: "gid://shopify/Collection/3",
          hasProduct: true,
        },
      ],
      expected: ["gid://shopify/Collection/3"],
    },
    {
      ids: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
      nodes: [null, null],
      expected: [],
    },
  ];

  for (const { ids, nodes, expected } of cases) {
    const admin = {
      async graphql(_query) {
        return {
          async json() {
            return { data: { nodes } };
          },
        };
      },
    };
    const result = await getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ids,
    );
    assert.deepEqual(result, expected);
  }
});

test("multi-batch membership failure leaks no partial matches", async () => {
  let call = 0;
  const admin = {
    async graphql(_query, { variables }) {
      call += 1;
      return {
        async json() {
          if (call === 1) {
            return {
              data: {
                nodes: variables.ids.map((id) => ({
                  __typename: "Collection",
                  id,
                  hasProduct: true,
                })),
              },
            };
          }
          return { errors: [{ message: "second batch failed" }] };
        },
      };
    },
  };
  const ids = Array.from(
    { length: 51 },
    (_, index) => `gid://shopify/Collection/${index + 1}`,
  );
  assert.equal(await getMatchingCollectionIds(
    admin,
    "gid://shopify/Product/7",
    ids,
  ), null);
});

test("collection membership request timeout is deterministic and cleans timers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  try {
    let calls = 0;
    const admin = {
      graphql() {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const pending = getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    );
    assert.equal(calls, 1);
    const requestTimers = timers.filter((timer) => timer.delay === 8000);
    assert.ok(requestTimers.length >= 2);
    requestTimers.at(-1).callback();
    assert.equal(await pending, null);
    assert.equal(timers.every((timer) => timer.cleared), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("deadline before request race aborts started work and handles late rejection", async () => {
  const originalNow = Date.now;
  let now = 1000;
  let signal;
  let rejectRequest;
  const lateRequest = new Promise((_, reject) => {
    rejectRequest = reject;
  });
  Date.now = () => now;
  const admin = {
    graphql(_query, options) {
      signal = options.signal;
      now = 9001;
      return lateRequest;
    },
  };

  try {
    const result = await getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    );
    assert.equal(result, null);
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, true);
    rejectRequest(new Error("late rejection"));
    await Promise.resolve();
  } finally {
    Date.now = originalNow;
  }
});

test("collection membership JSON timeout is deterministic and cleans timers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  try {
    const admin = {
      async graphql() {
        return {
          json() {
            return new Promise(() => {});
          },
        };
      },
    };
    const pending = getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    );
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    assert.ok(timers.length >= 2);
    timers.at(-1).callback();
    assert.equal(await pending, null);
    assert.equal(timers.every((timer) => timer.cleared), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("later batches do not start after the overall deadline", async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  let calls = 0;
  const admin = {
    async graphql(_query, { variables }) {
      calls += 1;
      if (calls === 1) {
        now = 9001;
      }
      return {
        async json() {
          return {
            data: {
              nodes: variables.ids.map((id) => ({
                __typename: "Collection",
                id,
                hasProduct: true,
              })),
            },
          };
        },
      };
    },
  };
  const ids = Array.from(
    { length: 51 },
    (_, index) => `gid://shopify/Collection/${index + 1}`,
  );
  try {
    assert.equal(await getMatchingCollectionIds(
      admin,
      "gid://shopify/Product/7",
      ids,
    ), null);
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("membership cache isolates shop and product, coalesces and copies results", async () => {
  resetMembershipCacheForTests();
  let calls = 0;
  const admin = {
    async graphql() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        async json() {
          return {
            data: {
              nodes: [
                {
                  __typename: "Collection",
                  id: "gid://shopify/Collection/1",
                  hasProduct: true,
                },
              ],
            },
          };
        },
      };
    },
  };

  const first = getCachedMatchingCollectionIds(
    "shop-a.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1"],
  );
  const second = getCachedMatchingCollectionIds(
    "shop-a.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1"],
  );
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  left.push("gid://shopify/Collection/mutated");
  assert.deepEqual(
    await getCachedMatchingCollectionIds(
      "shop-a.test",
      admin,
      "gid://shopify/Product/7",
      ["gid://shopify/Collection/1"],
    ),
    ["gid://shopify/Collection/1"],
  );
  assert.deepEqual(right, ["gid://shopify/Collection/1"]);

  await getCachedMatchingCollectionIds(
    "shop-b.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1"],
  );
  assert.equal(calls, 2);

  await getCachedMatchingCollectionIds(
    "shop-a.test",
    admin,
    "gid://shopify/Product/8",
    ["gid://shopify/Collection/1"],
  );
  assert.equal(calls, 3);
});

test("membership cache sorted and deduplicated keys coalesce", async () => {
  resetMembershipCacheForTests();
  let calls = 0;
  const admin = {
    async graphql() {
      calls += 1;
      return {
        async json() {
          return { data: { nodes: [
            { __typename: "Collection", id: "gid://shopify/Collection/1", hasProduct: true },
            { __typename: "Collection", id: "gid://shopify/Collection/2", hasProduct: false },
          ] } };
        },
      };
    },
  };
  const left = getCachedMatchingCollectionIds(
    "shop.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/2", "gid://shopify/Collection/1", "gid://shopify/Collection/1"],
  );
  const right = getCachedMatchingCollectionIds(
    "shop.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
  );
  await Promise.all([left, right]);
  assert.equal(calls, 1);
  resetMembershipCacheForTests();
});

test("membership cache with full pending capacity rejects misses without duplicate work", async () => {
  resetMembershipCacheForTests();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => ({ callback, delay, cleared: false });
  globalThis.clearTimeout = () => {};
  let calls = 0;
  const admin = {
    graphql() {
      calls += 1;
      return new Promise(() => {});
    },
  };

  try {
    const pending = [];
    for (let index = 0; index < 500; index += 1) {
      pending.push(getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        `gid://shopify/Product/${index + 1}`,
        ["gid://shopify/Collection/1"],
      ));
    }
    await Promise.resolve();
    const before = calls;
    assert.equal(await getCachedMatchingCollectionIds(
      "shop.test",
      admin,
      "gid://shopify/Product/501",
      ["gid://shopify/Collection/1"],
    ), null);
    assert.equal(calls, before);
  } finally {
    resetMembershipCacheForTests();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("membership cache evicts settled entries and recovers after failure", async () => {
  resetMembershipCacheForTests();
  let calls = 0;
  const admin = {
    async graphql(_query, { variables }) {
      calls += 1;
      if (calls === 1) {
        return { async json() { return { errors: [{ message: "temporary" }] }; } };
      }
      return {
        async json() {
          return { data: { nodes: variables.ids.map((id) => ({
            __typename: "Collection",
            id,
            hasProduct: true,
          })) } };
        },
      };
    },
  };
  assert.equal(await getCachedMatchingCollectionIds(
    "shop.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1"],
  ), null);
  assert.deepEqual(await getCachedMatchingCollectionIds(
    "shop.test",
    admin,
    "gid://shopify/Product/7",
    ["gid://shopify/Collection/1"],
  ), null);
  assert.equal(calls, 1);
});

test("membership cache evicts one settled entry when capacity is full", async () => {
  resetMembershipCacheForTests();
  let calls = 0;
  const admin = {
    async graphql(_query, { variables }) {
      calls += 1;
      return {
        async json() {
          return { data: { nodes: variables.ids.map((id) => ({
            __typename: "Collection",
            id,
            hasProduct: false,
          })) } };
        },
      };
    },
  };
  for (let index = 0; index < 500; index += 1) {
    await getCachedMatchingCollectionIds(
      `shop.test`,
      admin,
      `gid://shopify/Product/${index + 1}`,
      ["gid://shopify/Collection/1"],
    );
  }
  assert.equal(calls, 500);
  assert.deepEqual(await getCachedMatchingCollectionIds(
    "shop.test",
    admin,
    "gid://shopify/Product/501",
    ["gid://shopify/Collection/1"],
  ), []);
  assert.equal(calls, 501);
  resetMembershipCacheForTests();
});

test("membership cache failure and success TTLs are conservative", async () => {
  resetMembershipCacheForTests();
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    let calls = 0;
    const admin = {
      async graphql() {
        calls += 1;
        return {
          async json() {
            return calls === 1
              ? { errors: [{ message: "temporary" }] }
              : {
                  data: {
                    nodes: [
                      {
                        __typename: "Collection",
                        id: "gid://shopify/Collection/1",
                        hasProduct: true,
                      },
                    ],
                  },
                };
          },
        };
      },
    };

    assert.equal(
      await getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        "gid://shopify/Product/7",
        ["gid://shopify/Collection/1"],
      ),
      null,
    );
    now += 4999;
    assert.equal(
      await getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        "gid://shopify/Product/7",
        ["gid://shopify/Collection/1"],
      ),
      null,
    );
    assert.equal(calls, 1);
    now += 2;
    assert.deepEqual(
      await getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        "gid://shopify/Product/7",
        ["gid://shopify/Collection/1"],
      ),
      ["gid://shopify/Collection/1"],
    );
    assert.equal(calls, 2);

    now += 29999;
    assert.deepEqual(
      await getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        "gid://shopify/Product/7",
        ["gid://shopify/Collection/1"],
      ),
      ["gid://shopify/Collection/1"],
    );
    assert.equal(calls, 2);
    now += 2;
    assert.deepEqual(
      await getCachedMatchingCollectionIds(
        "shop.test",
        admin,
        "gid://shopify/Product/7",
        ["gid://shopify/Collection/1"],
      ),
      ["gid://shopify/Collection/1"],
    );
    assert.equal(calls, 3);
  } finally {
    Date.now = originalNow;
    resetMembershipCacheForTests();
  }
});

test("billing gates preserve Free limit, Pro unlimited, and invalid counts", () => {
  assert.equal(activeWidgetLimitForPlan("FREE"), 1);
  assert.equal(activeWidgetLimitForPlan("PRO"), null);
  assert.equal(canActivateAnotherWidget("FREE", 0), true);
  assert.equal(canActivateAnotherWidget("FREE", 1), false);
  assert.equal(canActivateAnotherWidget("PRO", 100), true);
  assert.throws(() => canActivateAnotherWidget("FREE", -1));
});

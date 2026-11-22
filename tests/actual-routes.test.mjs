import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import {
  matchesTargeting,
  readTargetingContext,
  readTargetingForm,
} from "../app/features/widgets/targeting.shared.ts";
import { activeWidgetLimitForPlan, canActivateAnotherWidget } from "../app/features/billing/plan-policy.server.ts";

function loadActualRoute(relativePath, mocks) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    URL,
    Response,
    FormData,
    Date,
    Intl,
    setTimeout,
    clearTimeout,
  });

  const requireMock = (specifier) => {
    if (specifier === "react-router") {
      return mocks["react-router"] ?? {
        Form: () => null,
        Link: () => null,
        useActionData: () => null,
        useLoaderData: () => null,
        useLocation: () => ({ key: "test" }),
      };
    }
    if (specifier === "react") {
      return mocks.react ?? { useEffect: () => {}, useState: (value) => [value, () => {}] };
    }
    if (specifier === "react/jsx-runtime") {
      return { jsx: () => null, jsxs: () => null, Fragment: Symbol("Fragment") };
    }
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
      return mocks[specifier];
    }
    throw new Error(`Unexpected route import in test: ${specifier}`);
  };

  const wrapper = vm.runInContext(
    `(function (exports, require, module, __filename, __dirname) {${output}\n})`,
    context,
  );
  wrapper(module.exports, requireMock, module, relativePath, ".");
  return module.exports;
}

function makeDb() {
  return {
    widget: {
      findMany: async () => [],
      findFirst: async () => null,
      count: async () => 0,
      create: async (args) => args,
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 1 }),
    },
  };
}

function makeAdminMocks({ db, shop = "shop.test", plan = "FREE", verification = { ok: true } } = {}) {
  const state = {
    plan,
    verification,
    planCalls: 0,
    planError: null,
  };
  const authenticate = {
    admin: async () => ({
      session: { shop },
      admin: {},
    }),
    public: {
      appProxy: async () => ({ session: { shop }, admin: {} }),
    },
  };
  const mocks = {
    "../shopify.server": { authenticate },
    "../db.server": { __esModule: true, default: db },
    "../features/widgets/widget.constants": {
      WIDGET_STATUSES: { DRAFT: "DRAFT", ACTIVE: "ACTIVE" },
      WIDGET_TYPES: { ANNOUNCEMENT: "ANNOUNCEMENT", NOTICE: "NOTICE", COUNTDOWN: "COUNTDOWN" },
    },
    "../features/widgets/widget.server": {
      widgetScope: (shopDomain, type) => ({ shopDomain, type }),
      widgetIdScope: (shopDomain, type, id) => ({ shopDomain, type, id }),
      activeWidgetScope: (shopDomain, type, excludeId) => ({
        shopDomain,
        type,
        ...(excludeId ? { excludeId } : {}),
      }),
    },
    "../features/widgets/success-toast.server": {
      redirectWithSuccessToast: (type, action) => ({ redirect: { type, action } }),
    },
    "../features/billing/admin-plan.server": {
      getAuthenticatedAppPlan: async () => {
        state.planCalls += 1;
        if (state.planError) throw state.planError;
        return state.plan;
      },
    },
    "../features/billing/plan-policy.server": {
      activeWidgetLimitForPlan,
      canActivateAnotherWidget,
    },
    "../features/widgets/targeting.shared": {
      __esModule: true,
      matchesTargeting,
      readTargetingContext,
      readTargetingForm,
    },
    "../features/widgets/targeting.server": {
      verifyTargetingSelection: async () => state.verification,
    },
    "../components/LoadingSubmitButton": { __esModule: true, default: () => null },
    "../features/widgets/WidgetTargetingFields": { __esModule: true, default: () => null },
    "../features/widgets/CountdownPreview": { __esModule: true, default: () => null },
  };
  return { mocks, state };
}

function form(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function actionRequest(entries) {
  const data = form(entries);
  return new Request("https://shop.test/app/test", {
    method: "POST",
    body: data,
  });
}

test("actual admin routes scope create/update, clear selections, and reject invalid writes", async () => {
  for (const [path, type, required] of [
    ["../app/routes/app.announcement.tsx", "ANNOUNCEMENT", {
      name: "Sale",
      message: "Sale now",
      targetingMode: "ALL",
      targetProductIds: JSON.stringify(["gid://shopify/Product/1"]),
      targetCollectionIds: JSON.stringify(["gid://shopify/Collection/1"]),
    }],
    ["../app/routes/app.notice.tsx", "NOTICE", {
      name: "Notice",
      message: "Important",
      targetingMode: "ALL",
      targetProductIds: JSON.stringify(["gid://shopify/Product/1"]),
      targetCollectionIds: JSON.stringify(["gid://shopify/Collection/1"]),
    }],
  ]) {
    const db = makeDb();
    let created;
    db.widget.create = async (args) => { created = args; return args; };
    db.widget.findFirst = async ({ where }) => {
      if (where.id) return { id: "w1", status: "DRAFT" };
      return null;
    };
    const { mocks } = makeAdminMocks({ db, shop: "shop-a.test" });
    const route = loadActualRoute(path, mocks);

    const createdResult = await route.action({
      request: await actionRequest({
        _action: "create",
        status: "DRAFT",
        ...required,
      }),
    });
    assert.ok(createdResult.redirect);
    assert.equal(created.data.shopDomain, "shop-a.test");
    assert.equal(created.data.type, type);
    assert.equal(created.data.targetingMode, "ALL");
    assert.deepEqual(created.data.targetProductIds, []);
    assert.deepEqual(created.data.targetCollectionIds, []);

    db.widget.updateMany = async (args) => {
      assert.deepEqual(args.where, { shopDomain: "shop-a.test", type, id: "w1" });
      return { count: 1 };
    };
    await route.action({
      request: await actionRequest({
        _action: "update",
        widgetId: "w1",
        status: "DRAFT",
        ...required,
      }),
    });

    db.widget.updateMany = async () => ({ count: 0 });
    const missing = await route.action({
      request: await actionRequest({
        _action: "update",
        widgetId: "foreign",
        status: "DRAFT",
        ...required,
      }),
    });
    assert.match(missing.error, /could not be found/i);

    const invalid = await route.action({
      request: await actionRequest({
        _action: "create",
        status: "DRAFT",
        name: "Valid name",
        message: "Valid message",
        targetingMode: "UNKNOWN",
      }),
    });
    assert.equal(invalid.error, "Please choose a valid targeting option.");
  }
});

test("actual countdown route validates, persists countdown fields, and allows already-Active expired edits", async () => {
  const db = makeDb();
  let created;
  db.widget.create = async (args) => { created = args; return args; };
  db.widget.findFirst = async () => ({ id: "c1", status: "ACTIVE" });
  const { mocks } = makeAdminMocks({ db, shop: "shop-a.test" });
  const route = loadActualRoute("../app/routes/app.countdown.tsx", mocks);

  const future = "2099-01-01T00:00:00.000Z";
  const request = await actionRequest({
    _action: "update",
    widgetId: "c1",
    name: "Sale",
    message: "Ends soon",
    status: "ACTIVE",
    countdownEndsAt: "2020-01-01T00:00:00.000Z",
    countdownTimeZone: "UTC",
    countdownSticky: "on",
    countdownDesktopOffset: "10",
    countdownMobileOffset: "20",
    countdownExpiredText: "Done",
    countdownShowDays: "on",
    backgroundColor: "#111111",
    textColor: "#FFFFFF",
    targetingMode: "ALL",
  });
  const result = await route.action({ request });
  assert.ok(result.redirect);
  assert.equal(created, undefined);

  db.widget.updateMany = async (args) => {
    assert.equal(args.data.countdownSticky, true);
    assert.equal(args.data.countdownShowDays, true);
    assert.equal(args.data.countdownDesktopOffset, 10);
    assert.equal(args.data.countdownMobileOffset, 20);
    assert.equal(args.data.countdownExpiredText, "Done");
    assert.deepEqual(args.data.targetProductIds, []);
    return { count: 1 };
  };
  await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: "c1",
      name: "Sale",
      message: "Ends soon",
      status: "ACTIVE",
      countdownEndsAt: "2020-01-01T00:00:00.000Z",
      countdownTimeZone: "UTC",
      countdownSticky: "on",
      countdownDesktopOffset: "10",
      countdownMobileOffset: "20",
      countdownExpiredText: "Done",
      countdownShowDays: "on",
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      targetingMode: "ALL",
    }),
  });
  void future;
});

test("actual countdown checkbox contract persists checked and unchecked create/update values", async () => {
  const db = makeDb();
  db.widget.findFirst = async () => ({ id: "c1", status: "DRAFT" });
  let createdData;
  let updatedData;
  db.widget.create = async (args) => { createdData = args.data; return args; };
  db.widget.updateMany = async (args) => { updatedData = args.data; return { count: 1 }; };
  const { mocks } = makeAdminMocks({ db });
  const route = loadActualRoute("../app/routes/app.countdown.tsx", mocks);

  await route.action({
    request: await actionRequest({
      _action: "create",
      name: "Checked",
      message: "Checked fields",
      status: "DRAFT",
      countdownEndsAt: "2099-01-01T00:00:00.000Z",
      countdownTimeZone: "UTC",
      countdownSticky: "on",
      countdownShowDays: "on",
      countdownDesktopOffset: "0",
      countdownMobileOffset: "0",
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      targetingMode: "ALL",
    }),
  });
  assert.equal(createdData.countdownSticky, true);
  assert.equal(createdData.countdownShowDays, true);

  await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: "c1",
      name: "Unchecked",
      message: "Unchecked fields",
      status: "DRAFT",
      countdownEndsAt: "2099-01-01T00:00:00.000Z",
      countdownTimeZone: "UTC",
      countdownDesktopOffset: "0",
      countdownMobileOffset: "0",
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      targetingMode: "ALL",
    }),
  });
  assert.equal(updatedData.countdownSticky, false);
  assert.equal(updatedData.countdownShowDays, false);
});

test("actual admin routes reject verification/status/action failures and zero-count delete/update", async () => {
  for (const [path, type] of [
    ["../app/routes/app.announcement.tsx", "ANNOUNCEMENT"],
    ["../app/routes/app.notice.tsx", "NOTICE"],
  ]) {
    const db = makeDb();
    let writes = 0;
    db.widget.create = async () => { writes += 1; };
    db.widget.updateMany = async () => ({ count: 0 });
    db.widget.deleteMany = async () => ({ count: 0 });
    db.widget.findFirst = async () => ({ id: "foreign", status: "DRAFT" });
    const { mocks, state } = makeAdminMocks({ db, verification: { ok: false, error: "verify failed" } });
    const route = loadActualRoute(path, mocks);
    const base = {
      name: "Name",
      message: "Message",
      status: "DRAFT",
      targetingMode: "ALL",
    };
    assert.match((await route.action({ request: await actionRequest({ _action: "bogus", ...base }) })).error, /Invalid/);
    assert.match((await route.action({ request: await actionRequest({ ...base, _action: "create", status: "BAD" }) })).error, /Draft or Active/);
    assert.match((await route.action({ request: await actionRequest({ _action: "create", ...base }) })).error, /verify failed/);
    assert.match((await route.action({ request: await actionRequest({ _action: "update", widgetId: "w1", ...base }) })).error, /verify failed/);
    assert.equal(writes, 0);
    assert.match((await route.action({ request: await actionRequest({ _action: "delete", widgetId: "foreign" }) })).error, /could not be found/i);
    db.widget.updateMany = async () => ({ count: 0 });
    state.verification = { ok: true };
  }

  const db = makeDb();
  db.widget.findFirst = async () => null;
  const { mocks } = makeAdminMocks({ db });
  const countdown = loadActualRoute("../app/routes/app.countdown.tsx", mocks);
  const invalidStatus = await countdown.action({
    request: await actionRequest({
      _action: "create",
      name: "C",
      message: "M",
      status: "BAD",
      countdownEndsAt: "2099-01-01T00:00:00.000Z",
      countdownTimeZone: "UTC",
      targetingMode: "ALL",
    }),
  });
  assert.match(invalidStatus.error, /Draft or Active/);
});

test("actual active gates preserve first Active bypass, Free/Pro, billing failure, and Draft bypass", async () => {
  for (const [path, type] of [
    ["../app/routes/app.announcement.tsx", "ANNOUNCEMENT"],
    ["../app/routes/app.notice.tsx", "NOTICE"],
  ]) {
    const db = makeDb();
    db.widget.count = async () => 0;
    db.widget.create = async (args) => args;
    const { mocks, state } = makeAdminMocks({ db, plan: "FREE" });
    const route = loadActualRoute(path, mocks);
    const base = {
      _action: "create",
      name: "Name",
      message: "Message",
      status: "ACTIVE",
      targetingMode: "ALL",
    };
    assert.ok((await route.action({ request: await actionRequest(base) })).redirect);
    assert.equal(state.planCalls, 0);

    db.widget.count = async () => 1;
    assert.match((await route.action({ request: await actionRequest(base) })).error, /Free plan allows one/);
    assert.equal(state.planCalls, 1);

    state.plan = "PRO";
    assert.ok((await route.action({ request: await actionRequest(base) })).redirect);

    state.planError = new Error("billing unavailable");
    assert.match((await route.action({ request: await actionRequest(base) })).error, /could not verify your plan/i);

    state.planError = null;
    const draft = await route.action({
      request: await actionRequest({ ...base, status: "DRAFT" }),
    });
    assert.ok(draft.redirect);
  }
});

test("actual proxy loaders filter before display cap and keep exact legacy/multi shapes", async () => {
  const cases = [
    ["../app/routes/api.proxy.announcement.ts", "ANNOUNCEMENT", "announcements", "announcement"],
    ["../app/routes/api.proxy.notice.ts", "NOTICE", "notices", "notice"],
    ["../app/routes/api.proxy.countdown.ts", "COUNTDOWN", "countdowns", "countdown"],
  ];

  for (const [path, type, plural, single] of cases) {
    const db = makeDb();
    let findArgs;
    db.widget.findMany = async (args) => {
      findArgs = args;
      return [
        {
          id: "a1",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          message: "all",
          buttonText: null,
          buttonUrl: null,
          position: "TOP",
          backgroundColor: "#111111",
          textColor: "#FFFFFF",
          dismissible: true,
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownShowDays: true,
          countdownSticky: true,
          countdownDesktopOffset: 10,
          countdownMobileOffset: 20,
          countdownExpiredText: "Expired",
        },
        {
          id: "p1",
          targetingMode: "PRODUCTS",
          targetProductIds: ["gid://shopify/Product/101"],
          targetCollectionIds: [],
          message: "product",
          buttonText: null,
          buttonUrl: null,
          position: "TOP",
          backgroundColor: "#222222",
          textColor: "#FFFFFF",
          dismissible: true,
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownShowDays: false,
          countdownSticky: false,
          countdownDesktopOffset: 0,
          countdownMobileOffset: 0,
          countdownExpiredText: "Expired",
        },
        {
          id: "c1",
          targetingMode: "COLLECTIONS",
          targetProductIds: [],
          targetCollectionIds: ["gid://shopify/Collection/201"],
          message: "collection",
          buttonText: null,
          buttonUrl: null,
          position: "TOP",
          backgroundColor: "#333333",
          textColor: "#FFFFFF",
          dismissible: true,
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownShowDays: false,
          countdownSticky: false,
          countdownDesktopOffset: 0,
          countdownMobileOffset: 0,
          countdownExpiredText: "Expired",
        },
      ];
    };
    let cacheCalls = 0;
    const mocks = {
      "../shopify.server": {
        authenticate: {
          public: {
            appProxy: async () => ({ session: { shop: "shop.test" }, admin: {} }),
          },
        },
      },
      "../db.server": { __esModule: true, default: db },
      "../features/widgets/widget.constants": {
        WIDGET_STATUSES: { ACTIVE: "ACTIVE", DRAFT: "DRAFT" },
        WIDGET_TYPES: { ANNOUNCEMENT: "ANNOUNCEMENT", NOTICE: "NOTICE", COUNTDOWN: "COUNTDOWN" },
      },
      "../features/widgets/widget.server": {
        widgetScope: (shop, widgetType) => ({ shopDomain: shop, type: widgetType }),
      },
      "../features/billing/storefront-plan.server": {
        getStorefrontWidgetLimit: async () => 1,
      },
      "../features/widgets/targeting.shared": {
        __esModule: true,
        matchesTargeting,
        readTargetingContext,
        readTargetingForm,
      },
      "../features/widgets/targeting.server": {
        getCachedMatchingCollectionIds: async (_shop, _admin, _product, ids) => {
          cacheCalls += 1;
          return ids.length ? ["gid://shopify/Collection/201"] : [];
        },
      },
    };
    const route = loadActualRoute(path, mocks);
    const url =
      `https://shop.test/apps/notice-pro?np_page=product&np_product=101&format=multi`;
    const result = await route.loader({ request: new Request(url) });
    const body = await result.json();

    assert.equal(findArgs.where.type, type);
    assert.equal(findArgs.orderBy[0].createdAt, "asc");
    assert.equal(findArgs.orderBy[1].id, "asc");
    assert.ok(findArgs.where.AND);
    assert.equal(cacheCalls, 1);
    assert.equal(Array.isArray(body[plural]), true);
    assert.equal(body[plural].length, 1);
    assert.equal(body[plural][0].message, "all");
    assert.equal("targetingMode" in body[plural][0], false);
    assert.equal("targetProductIds" in body[plural][0], false);
    assert.equal("targetCollectionIds" in body[plural][0], false);
    if (type === "COUNTDOWN") {
      assert.ok(body.serverNow);
      assert.equal(typeof body.serverNow, "string");
    }
  }
});

test("real targeting context parser handles numeric IDs, precision, duplicates, and forged claims", () => {
  assert.deepEqual(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=product&np_product=9007199254740993"),
    ),
    {
      pageType: "product",
      productId: "gid://shopify/Product/9007199254740993",
      collectionIds: [],
    },
  );
  assert.deepEqual(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=collection&np_collection=201"),
    ),
    {
      pageType: "collection",
      productId: null,
      collectionIds: ["gid://shopify/Collection/201"],
    },
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=product&np_product=101&np_product=102"),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=product&np_product=gid://shopify/Product/101"),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=other&np_collection=201"),
    ).pageType,
    "other",
  );
  assert.equal(
    readTargetingContext(
      new URL("https://shop.test/a?np_page=product&np_product=101&np_collection=201"),
    ).pageType,
    "other",
  );
  assert.equal(
    matchesTargeting(
      {
        targetingMode: "COLLECTIONS",
        targetProductIds: [],
        targetCollectionIds: ["gid://shopify/Collection/201"],
      },
      readTargetingContext(
        new URL("https://shop.test/a?np_page=product&np_product=101&np_collection=201"),
      ),
    ),
    false,
  );
});

test("actual proxy auth failure skips database access and unknown modes fail closed", async () => {
  for (const path of [
    "../app/routes/api.proxy.announcement.ts",
    "../app/routes/api.proxy.notice.ts",
    "../app/routes/api.proxy.countdown.ts",
  ]) {
    let dbCalls = 0;
    const db = makeDb();
    db.widget.findMany = async () => { dbCalls += 1; return []; };
    const mocks = {
      "../shopify.server": {
        authenticate: {
          public: {
            appProxy: async () => ({ session: null, admin: null }),
          },
        },
      },
      "../db.server": { __esModule: true, default: db },
      "../features/widgets/widget.constants": {
        WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
        WIDGET_TYPES: { ANNOUNCEMENT: "ANNOUNCEMENT", NOTICE: "NOTICE", COUNTDOWN: "COUNTDOWN" },
      },
      "../features/widgets/widget.server": { widgetScope: () => ({}) },
      "../features/billing/storefront-plan.server": { getStorefrontWidgetLimit: async () => 1 },
      "../features/widgets/targeting.shared": {
        __esModule: true,
        matchesTargeting,
        readTargetingContext,
        readTargetingForm,
      },
      "../features/widgets/targeting.server": { getCachedMatchingCollectionIds: async () => [] },
    };
    const route = loadActualRoute(path, mocks);
    const response = await route.loader({
      request: new Request("https://shop.test/apps/notice-pro"),
    });
    assert.equal(response.status, 401);
    assert.equal(dbCalls, 0);
  }

  assert.equal(matchesTargeting(
    { targetingMode: "MYSTERY", targetProductIds: [], targetCollectionIds: [] },
    { pageType: "product", productId: "gid://shopify/Product/101", collectionIds: [] },
  ), false);
});

test("proxy membership failure retains ALL/direct-product matches and excludes collection matches", async () => {
  for (const [path, plural] of [
    ["../app/routes/api.proxy.announcement.ts", "announcements"],
    ["../app/routes/api.proxy.notice.ts", "notices"],
    ["../app/routes/api.proxy.countdown.ts", "countdowns"],
  ]) {
    const db = makeDb();
    db.widget.findMany = async () => [
      {
        id: "all",
        targetingMode: "ALL",
        targetProductIds: [],
        targetCollectionIds: [],
        message: "all",
        buttonText: null,
        buttonUrl: null,
        position: "TOP",
        backgroundColor: "#111111",
        textColor: "#FFFFFF",
        dismissible: true,
        countdownEndsAt: "2099-01-01T00:00:00.000Z",
        countdownShowDays: false,
        countdownSticky: false,
        countdownDesktopOffset: 0,
        countdownMobileOffset: 0,
        countdownExpiredText: "Expired",
      },
      {
        id: "direct",
        targetingMode: "PRODUCTS",
        targetProductIds: ["gid://shopify/Product/101"],
        targetCollectionIds: [],
        message: "direct",
        buttonText: null,
        buttonUrl: null,
        position: "TOP",
        backgroundColor: "#222222",
        textColor: "#FFFFFF",
        dismissible: true,
        countdownEndsAt: "2099-01-01T00:00:00.000Z",
        countdownShowDays: false,
        countdownSticky: false,
        countdownDesktopOffset: 0,
        countdownMobileOffset: 0,
        countdownExpiredText: "Expired",
      },
      {
        id: "collection",
        targetingMode: "COLLECTIONS",
        targetProductIds: [],
        targetCollectionIds: ["gid://shopify/Collection/201"],
        message: "collection",
        buttonText: null,
        buttonUrl: null,
        position: "TOP",
        backgroundColor: "#333333",
        textColor: "#FFFFFF",
        dismissible: true,
        countdownEndsAt: "2099-01-01T00:00:00.000Z",
        countdownShowDays: false,
        countdownSticky: false,
        countdownDesktopOffset: 0,
        countdownMobileOffset: 0,
        countdownExpiredText: "Expired",
      },
    ];
    const mocks = {
      "../shopify.server": {
        authenticate: {
          public: { appProxy: async () => ({ session: { shop: "shop.test" }, admin: {} }) },
        },
      },
      "../db.server": { __esModule: true, default: db },
      "../features/widgets/widget.constants": {
        WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
        WIDGET_TYPES: { ANNOUNCEMENT: "ANNOUNCEMENT", NOTICE: "NOTICE", COUNTDOWN: "COUNTDOWN" },
      },
      "../features/widgets/widget.server": { widgetScope: () => ({}) },
      "../features/billing/storefront-plan.server": { getStorefrontWidgetLimit: async () => 10 },
      "../features/widgets/targeting.shared": {
        __esModule: true,
        matchesTargeting,
        readTargetingContext,
        readTargetingForm,
      },
      "../features/widgets/targeting.server": {
        getCachedMatchingCollectionIds: async () => null,
      },
    };
    const route = loadActualRoute(path, mocks);
    const multi = await route.loader({
      request: new Request("https://shop.test/apps/notice-pro?np_page=product&np_product=101&format=multi"),
    });
    const body = await multi.json();
    assert.deepEqual(body[plural].map((item) => item.message), ["all", "direct"]);

    const legacy = await route.loader({
      request: new Request("https://shop.test/apps/notice-pro?np_page=product&np_product=101"),
    });
    const legacyBody = await legacy.json();
    if (path.includes("countdown")) {
      assert.equal(typeof legacyBody.countdown?.message === "undefined" || legacyBody.countdown?.message === "all", true);
      assert.ok(legacyBody.serverNow);
    } else {
      assert.equal(legacyBody.message, "all");
    }
  }
});

test("actual countdown route rejects new expired activation but not already-Active expired editing", async () => {
  const db = makeDb();
  db.widget.findFirst = async () => null;
  const { mocks } = makeAdminMocks({ db });
  const route = loadActualRoute("../app/routes/app.countdown.tsx", mocks);
  const base = {
    _action: "create",
    name: "C",
    message: "M",
    status: "ACTIVE",
    countdownEndsAt: "2020-01-01T00:00:00.000Z",
    countdownTimeZone: "UTC",
    countdownDesktopOffset: "0",
    countdownMobileOffset: "0",
    countdownExpiredText: "Expired",
    backgroundColor: "#111111",
    textColor: "#FFFFFF",
    targetingMode: "ALL",
  };
  assert.match((await route.action({ request: await actionRequest(base) })).error, /future deadline/i);

  db.widget.findFirst = async () => ({ id: "c1", status: "ACTIVE" });
  db.widget.updateMany = async (args) => {
    assert.equal(args.data.countdownEndsAt instanceof Date, true);
    assert.equal(args.data.countdownTimeZone, "UTC");
    assert.equal(args.data.countdownSticky, false);
    assert.equal(args.data.countdownExpiredText, "Expired");
    return { count: 1 };
  };
  const edited = await route.action({
    request: await actionRequest({ ...base, _action: "update", widgetId: "c1" }),
  });
  assert.ok(edited.redirect);

  db.widget.deleteMany = async () => ({ count: 0 });
  assert.match((await route.action({
    request: await actionRequest({ _action: "delete", widgetId: "foreign" }),
  })).error, /could not be found/i);
});

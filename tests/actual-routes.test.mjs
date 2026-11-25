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
import {
  COUNTRY_TARGETING_MODES,
  readCountryTargetingForm,
} from "../app/features/widgets/country-targeting.shared.ts";
import { filterByCountryTargeting } from "../app/features/widgets/country-targeting.server.ts";
import {
  boundCountryAttestationRequest,
  resolveVisitorCountry,
} from "../app/features/widgets/country-resolution.server.ts";
import { issueCountryChallenge } from "../app/features/widgets/country-attestation.server.ts";
import { createCountryAttestationWorker } from "../country-attestation-worker/src/index.js";
import {
  getNoticeEditorMutationSignal,
  getNoticeEditorResetKey,
} from "../app/features/widgets/notice-editor-reset.ts";
import {
  getWidgetEditorMutationSignal,
  getWidgetEditorResetKey,
} from "../app/features/widgets/widget-editor-reset.ts";
import { redirectWithSuccessToast } from "../app/features/widgets/success-toast.server.ts";
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
    URLSearchParams,
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
      return {
        jsx: () => null,
        jsxs: () => null,
        Fragment: Symbol("Fragment"),
      };
    }
    if (specifier === "../features/widgets/country-targeting.server") {
      return mocks[specifier] ?? { filterByCountryTargeting };
    }
    if (specifier === "../features/widgets/country-resolution.server") {
      return {
        boundCountryAttestationRequest,
        resolveVisitorCountry,
        ...mocks[specifier],
      };
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
      NOTICE_KINDS: { GENERAL: "GENERAL", DISPATCH: "DISPATCH" },
    },
    "../features/widgets/widget.server": {
      widgetScope: (shopDomain, type) => ({ shopDomain, type }),
      widgetIdScope: (shopDomain, type, id) => ({ shopDomain, type, id }),
      activeWidgetScope: (shopDomain, type, excludeId) => ({
        shopDomain,
        type,
        status: "ACTIVE",
        ...(excludeId ? { id: { not: excludeId } } : {}),
      }),
    },
    "../features/widgets/success-toast.server": {
      redirectWithSuccessToast: (type, action, searchParams) => ({
        redirect: { type, action, searchParams },
      }),
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
    "../features/widgets/country-targeting.shared": {
      readCountryTargetingForm,
    },
    "../features/widgets/targeting.server": {
      verifyTargetingSelection: async () => state.verification,
    },
    "../components/LoadingSubmitButton": { __esModule: true, default: () => null },
    "../features/widgets/WidgetTargetingFields": { __esModule: true, default: () => null },
    "../features/widgets/WidgetCountryTargetingFields": { __esModule: true, default: () => null },
    "../features/widgets/CountdownPreview": { __esModule: true, default: () => null },
    "../features/widgets/notice-editor-reset": {
      getNoticeEditorMutationSignal,
      getNoticeEditorResetKey,
    },
    "../features/widgets/widget-editor-reset": {
      getWidgetEditorMutationSignal,
      getWidgetEditorResetKey,
    },
  };
  state.verifiedTargeting = [];
  mocks["../features/widgets/targeting.server"].verifyTargetingSelection =
    async (_admin, targeting) => {
      state.verifiedTargeting.push(targeting);
      return state.verification;
    };
  return { mocks, state };
}

function form(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function actionRequest(entries, url = "https://shop.test/app/test") {
  const data = form(entries);
  return new Request(url, {
    method: "POST",
    body: data,
  });
}

test("country challenge route requires app-proxy auth and exposes no signing secret", async () => {
  const secret = "server-only-attestation-secret";
  let issuedFor = null;
  const mocks = {
    "../shopify.server": {
      authenticate: {
        public: {
          appProxy: async () => ({
            session: { shop: "noticepro-test.myshopify.com" },
            admin: {},
          }),
        },
      },
    },
    "../features/widgets/country-attestation.server": {
      readCountryAttestationConfiguration: () => ({
        enabled: true,
        secret,
        workerUrl: "https://worker.test/attest",
      }),
      issueCountryChallenge: (shop, receivedSecret) => {
        issuedFor = shop;
        assert.equal(receivedSecret, secret);
        return "signed-challenge";
      },
    },
  };
  const route = loadActualRoute(
    "../app/routes/api.proxy.country-challenge.ts",
    mocks,
  );
  const response = await route.loader({
    request: new Request("https://storefront.test/apps/noticepro/country-challenge"),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(issuedFor, "noticepro-test.myshopify.com");
  assert.deepEqual(body, {
    challenge: "signed-challenge",
    workerUrl: "https://worker.test/attest",
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));

  const unauthorizedRoute = loadActualRoute(
    "../app/routes/api.proxy.country-challenge.ts",
    {
      ...mocks,
      "../shopify.server": {
        authenticate: {
          public: {
            appProxy: async () => ({ session: null, admin: null }),
          },
        },
      },
    },
  );
  const unauthorized = await unauthorizedRoute.loader({
    request: new Request("https://origin.test/api/proxy/country-challenge"),
  });
  assert.equal(unauthorized.status, 401);
});

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
    if (type === "NOTICE") {
      assert.equal(created.data.noticeKind, "GENERAL");
    }
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

test("actual Notice route persists Dispatch, reopens it, and preserves message and targeting across kind switches", async () => {
  const db = makeDb();
  const rows = [];
  let nextId = 1;
  let revision = Date.parse("2026-11-23T12:00:00.000Z");
  const nextRevision = () => new Date(revision++);
  db.widget.findMany = async ({ where }) => {
    assert.deepEqual(where, { shopDomain: "shop-a.test", type: "NOTICE" });
    return rows;
  };
  db.widget.findFirst = async ({ where }) => {
    assert.deepEqual(where, {
      shopDomain: "shop-a.test",
      type: "NOTICE",
      id: where.id,
    });
    return rows.find((row) => row.id === where.id) ?? null;
  };
  db.widget.create = async ({ data }) => {
    rows.push({
      id: `n${nextId++}`,
      ...data,
      updatedAt: nextRevision(),
    });
    return rows.at(-1);
  };
  db.widget.updateMany = async ({ where, data }) => {
    const row = rows.find(
      (item) =>
        item.id === where.id &&
        item.shopDomain === where.shopDomain &&
        item.type === where.type,
    );
    if (!row) return { count: 0 };
    Object.assign(row, data, { updatedAt: nextRevision() });
    return { count: 1 };
  };

  const { mocks, state } = makeAdminMocks({ db, shop: "shop-a.test" });
  const route = loadActualRoute("../app/routes/app.notice.tsx", mocks);
  const productId = "gid://shopify/Product/101";
  const collectionId = "gid://shopify/Collection/201";
  const customMessage = "Made to order. Dispatch timing varies by item.";

  const created = await route.action({
    request: await actionRequest({
      _action: "create",
      name: "Dispatch estimate",
      message: customMessage,
      noticeKind: "DISPATCH",
      status: "DRAFT",
      targetingMode: "PRODUCTS",
      targetProductIds: JSON.stringify([productId]),
      targetCollectionIds: "[]",
    }),
  });
  assert.ok(created.redirect);
  assert.equal(rows[0].type, "NOTICE");
  assert.equal(rows[0].noticeKind, "DISPATCH");
  assert.equal(rows[0].message, customMessage);
  assert.deepEqual(rows[0].targetProductIds, [productId]);
  assert.deepEqual(rows[0].targetCollectionIds, []);
  assert.equal(
    matchesTargeting(state.verifiedTargeting[0], {
      pageType: "product",
      productId,
      collectionIds: [],
    }),
    true,
  );
  assert.equal(
    matchesTargeting(state.verifiedTargeting[0], {
      pageType: "product",
      productId: "gid://shopify/Product/999",
      collectionIds: [],
    }),
    false,
  );

  const firstReload = await route.loader({
    request: new Request(`https://shop.test/app/notice?edit=${rows[0].id}`),
  });
  assert.equal(firstReload.editingNotice.noticeKind, "DISPATCH");
  assert.equal(firstReload.editingNotice.message, customMessage);
  assert.deepEqual(firstReload.editingNotice.targetProductIds, [productId]);

  const editedMessage = "Usually dispatches in 1–2 business days.";
  const updated = await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: rows[0].id,
      name: "Dispatch estimate",
      message: editedMessage,
      noticeKind: "DISPATCH",
      status: "DRAFT",
      targetingMode: "COLLECTIONS",
      targetProductIds: "[]",
      targetCollectionIds: JSON.stringify([collectionId]),
    }),
  });
  assert.ok(updated.redirect);
  assert.equal(rows[0].noticeKind, "DISPATCH");
  assert.equal(rows[0].message, editedMessage);
  assert.deepEqual(rows[0].targetProductIds, []);
  assert.deepEqual(rows[0].targetCollectionIds, [collectionId]);
  assert.equal(
    matchesTargeting(state.verifiedTargeting[1], {
      pageType: "product",
      productId,
      collectionIds: [collectionId],
    }),
    true,
  );
  assert.equal(
    matchesTargeting(state.verifiedTargeting[1], {
      pageType: "product",
      productId,
      collectionIds: [],
    }),
    false,
  );

  const reopened = await route.loader({
    request: new Request(`https://shop.test/app/notice?edit=${rows[0].id}`),
  });
  assert.equal(reopened.editingNotice.noticeKind, "DISPATCH");
  assert.equal(reopened.editingNotice.message, editedMessage);
  assert.deepEqual(reopened.editingNotice.targetCollectionIds, [collectionId]);

  const switched = await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: rows[0].id,
      name: "Dispatch estimate",
      message: editedMessage,
      noticeKind: "GENERAL",
      status: "DRAFT",
      targetingMode: "COLLECTIONS",
      targetProductIds: "[]",
      targetCollectionIds: JSON.stringify([collectionId]),
    }),
  });
  assert.ok(switched.redirect);
  assert.equal(rows[0].noticeKind, "GENERAL");
  assert.equal(rows[0].message, editedMessage);
  assert.deepEqual(rows[0].targetCollectionIds, [collectionId]);
  const switchedReload = await route.loader({
    request: new Request(`https://shop.test/app/notice?edit=${rows[0].id}`),
  });
  assert.equal(switchedReload.editingNotice.noticeKind, "GENERAL");
  assert.equal(switchedReload.editingNotice.message, editedMessage);
  assert.deepEqual(switchedReload.editingNotice.targetCollectionIds, [collectionId]);
});

test("actual Notice route rejects invalid kinds without writes and shares the Free Active limit", async () => {
  const db = makeDb();
  let writes = 0;
  let countWhere;
  db.widget.create = async () => { writes += 1; };
  const existingGeneralActive = {
    shopDomain: "shop-a.test",
    type: "NOTICE",
    status: "ACTIVE",
    noticeKind: "GENERAL",
  };
  db.widget.count = async ({ where }) => {
    countWhere = where;
    return Number(
      existingGeneralActive.shopDomain === where.shopDomain &&
        existingGeneralActive.type === where.type &&
        existingGeneralActive.status === where.status,
    );
  };
  const { mocks, state } = makeAdminMocks({ db, shop: "shop-a.test" });
  const route = loadActualRoute("../app/routes/app.notice.tsx", mocks);
  const base = {
    _action: "create",
    name: "Dispatch",
    message: "Merchant-written estimate",
    status: "ACTIVE",
    targetingMode: "ALL",
  };

  const invalid = await route.action({
    request: await actionRequest({ ...base, noticeKind: "DELIVERY" }),
  });
  assert.match(invalid.error, /valid Notice kind/i);
  assert.equal(writes, 0);

  const freeLimit = await route.action({
    request: await actionRequest({ ...base, noticeKind: "DISPATCH" }),
  });
  assert.match(freeLimit.error, /Free plan allows one active Notice/i);
  assert.deepEqual(countWhere, {
    shopDomain: "shop-a.test",
    type: "NOTICE",
    status: "ACTIVE",
  });
  assert.equal(state.planCalls, 1);
  assert.equal(writes, 0);

  db.widget.deleteMany = async ({ where }) => {
    assert.deepEqual(where, {
      shopDomain: "shop-a.test",
      type: "NOTICE",
      id: "foreign-notice",
    });
    return { count: 0 };
  };
  const foreignDelete = await route.action({
    request: await actionRequest({
      _action: "delete",
      widgetId: "foreign-notice",
    }),
  });
  assert.match(foreignDelete.error, /could not be found/i);

  state.plan = "PRO";
  assert.ok(
    (
      await route.action({
        request: await actionRequest({ ...base, noticeKind: "DISPATCH" }),
      })
    ).redirect,
  );
  assert.equal(writes, 1);

  state.planError = new Error("billing unavailable");
  const billingFailure = await route.action({
    request: await actionRequest({ ...base, noticeKind: "GENERAL" }),
  });
  assert.match(billingFailure.error, /could not verify your plan/i);
  assert.equal(writes, 1);

  const draft = await route.action({
    request: await actionRequest({
      ...base,
      noticeKind: "DISPATCH",
      status: "DRAFT",
    }),
  });
  assert.ok(draft.redirect);
  assert.equal(writes, 2);
});

test("Dispatch storefront output reuses Notice targeting, keeps its proxy shape, and renders messages as text", async () => {
  const db = makeDb();
  const productId = "gid://shopify/Product/101";
  const collectionId = "gid://shopify/Collection/201";
  const unsafeLookingMessage = '<img src=x onerror="alert(1)">';
  db.widget.findMany = async (args) => {
    assert.equal(args.where.type, "NOTICE");
    assert.equal(args.orderBy[0].createdAt, "asc");
    assert.equal(args.orderBy[1].id, "asc");
    assert.ok(args.where.AND);
    return [
      {
        id: "dispatch-product",
        noticeKind: "DISPATCH",
        targetingMode: "PRODUCTS",
        targetProductIds: [productId],
        targetCollectionIds: [],
        countryTargetingMode: "ALL",
        targetCountryCodes: [],
        message: unsafeLookingMessage,
        buttonText: null,
        buttonUrl: null,
        backgroundColor: "#111111",
        textColor: "#FFFFFF",
        dismissible: true,
      },
      {
        id: "dispatch-collection",
        noticeKind: "DISPATCH",
        targetingMode: "COLLECTIONS",
        targetProductIds: [],
        targetCollectionIds: [collectionId],
        countryTargetingMode: "ALL",
        targetCountryCodes: [],
        message: "Dispatch estimate for this collection",
        buttonText: null,
        buttonUrl: null,
        backgroundColor: "#222222",
        textColor: "#FFFFFF",
        dismissible: true,
      },
    ];
  };
  let membershipCalls = 0;
  const mocks = {
    "../shopify.server": {
      authenticate: {
        public: {
          appProxy: async () => ({
            session: { shop: "shop.test" },
            admin: {},
          }),
        },
      },
    },
    "../db.server": { __esModule: true, default: db },
    "../features/widgets/widget.constants": {
      WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
      WIDGET_TYPES: { ANNOUNCEMENT: "ANNOUNCEMENT", NOTICE: "NOTICE", COUNTDOWN: "COUNTDOWN" },
    },
    "../features/widgets/widget.server": {
      widgetScope: (shop, type) => ({ shopDomain: shop, type }),
    },
    "../features/billing/storefront-plan.server": {
      getStorefrontWidgetLimit: async () => null,
    },
    "../features/widgets/targeting.shared": {
      __esModule: true,
      matchesTargeting,
      readTargetingContext,
      readTargetingForm,
    },
    "../features/widgets/targeting.server": {
      getCachedMatchingCollectionIds: async (_shop, _admin, _product, ids) => {
        membershipCalls += 1;
        return ids.includes(collectionId) ? [collectionId] : [];
      },
    },
  };
  const route = loadActualRoute("../app/routes/api.proxy.notice.ts", mocks);
  const productResponse = await route.loader({
    request: new Request(
      "https://shop.test/apps/noticepro/notice?np_page=product&np_product=101&format=multi",
    ),
  });
  const productBody = await productResponse.json();
  assert.deepEqual(
    productBody.notices.map((notice) => notice.id),
    ["dispatch-product", "dispatch-collection"],
  );
  assert.equal(productBody.notices[0].message, unsafeLookingMessage);
  assert.equal("noticeKind" in productBody.notices[0], false);
  assert.equal("targetingMode" in productBody.notices[0], false);
  assert.equal(membershipCalls, 1);

  const collectionResponse = await route.loader({
    request: new Request(
      "https://shop.test/apps/noticepro/notice?np_page=collection&np_collection=201&format=multi",
    ),
  });
  const collectionBody = await collectionResponse.json();
  assert.deepEqual(
    collectionBody.notices.map((notice) => notice.id),
    ["dispatch-collection"],
  );
  assert.equal(membershipCalls, 1);

  const noticeSource = fs.readFileSync(
    new URL(
      "../extensions/notice-pro-storefront/assets/notice.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(noticeSource, /message\.textContent = notice\.message/);
  assert.doesNotMatch(noticeSource, /\.innerHTML\s*=/);
});

test("Notice editor reset identity is scoped to destination and its successful mutation", async () => {
  const db = makeDb();
  const makeNotice = (id, updatedAt) => ({
    id,
    shopDomain: "shop-a.test",
    type: "NOTICE",
    name: `Notice ${id}`,
    status: "DRAFT",
    noticeKind: "GENERAL",
    message: `Saved ${id}`,
    buttonText: null,
    buttonUrl: null,
    backgroundColor: "#FEF3C7",
    textColor: "#111827",
    dismissible: true,
    targetingMode: "ALL",
    targetProductIds: [],
    targetCollectionIds: [],
    createdAt: new Date("2026-11-20T12:00:00.000Z"),
    updatedAt: new Date(updatedAt),
  });
  const rows = [
    makeNotice("a", "2026-11-21T12:00:00.000Z"),
    makeNotice("b", "2026-11-22T12:00:00.000Z"),
    makeNotice("c", "2026-11-22T13:00:00.000Z"),
  ];
  let nextId = 1;
  let revision = Date.parse("2026-11-23T12:00:00.000Z");
  let writes = 0;
  db.widget.findMany = async ({ where }) => {
    assert.deepEqual(where, { shopDomain: "shop-a.test", type: "NOTICE" });
    return [...rows].sort((left, right) => right.createdAt - left.createdAt);
  };
  db.widget.findFirst = async ({ where }) =>
    rows.find(
      (row) =>
        row.id === where.id &&
        row.shopDomain === where.shopDomain &&
        row.type === where.type,
    ) ?? null;
  db.widget.create = async ({ data }) => {
    writes += 1;
    const now = new Date(revision++);
    const row = makeNotice(`new-${nextId++}`, now);
    row.createdAt = now;
    Object.assign(row, data);
    rows.push(row);
    return row;
  };
  db.widget.updateMany = async ({ where, data }) => {
    const row = rows.find(
      (item) =>
        item.id === where.id &&
        item.shopDomain === where.shopDomain &&
        item.type === where.type,
    );
    if (!row) return { count: 0 };
    writes += 1;
    Object.assign(row, data, { updatedAt: new Date(revision++) });
    return { count: 1 };
  };
  db.widget.deleteMany = async ({ where }) => {
    const index = rows.findIndex(
      (row) =>
        row.id === where.id &&
        row.shopDomain === where.shopDomain &&
        row.type === where.type,
    );
    if (index < 0) return { count: 0 };
    rows.splice(index, 1);
    return { count: 1 };
  };

  const { mocks } = makeAdminMocks({ db, shop: "shop-a.test" });
  const route = loadActualRoute("../app/routes/app.notice.tsx", mocks);
  const load = (query = "") =>
    route.loader({
      request: new Request(`https://shop.test/app/notice${query}`),
    });
  const editorKey = (data, signal = null) =>
    getNoticeEditorResetKey(data.editingNotice?.id ?? null, signal);

  const initialCreate = await load();
  const ordinaryCreateRerender = await load();
  const initialCreateKey = editorKey(initialCreate);
  assert.equal(editorKey(ordinaryCreateRerender), initialCreateKey);

  const failedCreate = await route.action({
    request: await actionRequest({
      _action: "create",
      name: "Unsaved",
      message: "",
      noticeKind: "DISPATCH",
      status: "DRAFT",
      backgroundColor: "#123456",
      targetingMode: "ALL",
    }),
  });
  assert.match(failedCreate.error, /notice message/i);
  assert.equal(writes, 0);

  rows.push(makeNotice("external-create", "2026-11-23T12:00:00.000Z"));
  const afterUnrelatedCreate = await load();
  assert.equal(editorKey(afterUnrelatedCreate), initialCreateKey);

  rows.find((row) => row.id === "b").updatedAt = new Date(
    "2026-11-23T12:01:00.000Z",
  );
  const afterUnrelatedUpdate = await load();
  assert.equal(editorKey(afterUnrelatedUpdate), initialCreateKey);

  rows.splice(rows.findIndex((row) => row.id === "external-create"), 1);
  const afterUnrelatedDelete = await load();
  assert.equal(editorKey(afterUnrelatedDelete), initialCreateKey);

  const created = await route.action({
    request: await actionRequest({
      _action: "create",
      name: "New Dispatch",
      message: "Merchant-written estimate",
      noticeKind: "DISPATCH",
      status: "DRAFT",
      backgroundColor: "#123456",
      targetingMode: "ALL",
    }),
  });
  assert.ok(created.redirect);
  assert.equal(created.redirect.action, "created");
  const freshCreate = await load();
  const createSignal = getNoticeEditorMutationSignal(
    "?noticeproToast=notice.created&noticeproToastId=create-1",
  );
  assert.ok(createSignal);
  const freshCreateKey = editorKey(freshCreate, createSignal);
  assert.notEqual(freshCreateKey, initialCreateKey);
  assert.equal(freshCreate.editingNotice, null);
  assert.equal(freshCreate.notices[0].noticeKind, "DISPATCH");
  assert.equal(
    getNoticeEditorMutationSignal("", createSignal),
    createSignal,
    "removing toast query parameters must not remount the editor again",
  );
  assert.equal(editorKey(await load(), createSignal), freshCreateKey);

  const editingA = await load("?edit=a");
  const editingB = await load("?edit=b");
  const editingAKey = editorKey(editingA, createSignal);
  assert.notEqual(editorKey(editingB, createSignal), editingAKey);
  assert.equal(editingA.editingNotice.id, "a");
  assert.equal(editingB.editingNotice.id, "b");

  const beforeFailedEditKey = editingAKey;
  const failedEdit = await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: "a",
      name: "Unsaved A",
      message: "Unsaved custom message",
      noticeKind: "DISPATCH",
      status: "DRAFT",
      backgroundColor: "#654321",
      targetingMode: "PRODUCTS",
      targetProductIds: "[]",
    }),
  });
  assert.match(failedEdit.error, /select between/i);
  assert.equal(writes, 1);

  rows.find((row) => row.id === "a").updatedAt = new Date(
    "2026-11-23T12:02:00.000Z",
  );
  rows.find((row) => row.id === "b").updatedAt = new Date(
    "2026-11-23T12:03:00.000Z",
  );
  rows.push(makeNotice("concurrent-create", "2026-11-23T12:04:00.000Z"));
  rows.splice(rows.findIndex((row) => row.id === "c"), 1);
  assert.equal(
    editorKey(await load("?edit=a"), createSignal),
    beforeFailedEditKey,
    "failed submissions and concurrent Notice changes retain the same editor identity",
  );

  const unrelatedDelete = await route.action({
    request: await actionRequest(
      { _action: "delete", widgetId: "concurrent-create" },
      "https://shop.test/app/notice?edit=a",
    ),
  });
  assert.equal(unrelatedDelete.redirect.action, "deleted");
  assert.equal(unrelatedDelete.redirect.searchParams.get("edit"), "a");
  const deleteSignal = getNoticeEditorMutationSignal(
    "?edit=a&noticeproToast=notice.deleted&noticeproToastId=delete-1",
    createSignal,
  );
  assert.equal(deleteSignal, createSignal);
  assert.equal(editorKey(await load("?edit=a"), deleteSignal), editingAKey);

  const cancelledEdit = await load();
  assert.notEqual(editorKey(cancelledEdit, createSignal), editingAKey);
  assert.equal(cancelledEdit.editingNotice, null);

  const savedEdit = await route.action({
    request: await actionRequest({
      _action: "update",
      widgetId: "a",
      name: "Updated A",
      message: "Saved custom message",
      noticeKind: "DISPATCH",
      status: "DRAFT",
      backgroundColor: "#654321",
      targetingMode: "ALL",
    }),
  });
  assert.ok(savedEdit.redirect);
  assert.equal(savedEdit.redirect.action, "updated");
  const createAfterEdit = await load();
  const updateSignal = getNoticeEditorMutationSignal(
    "?noticeproToast=notice.updated&noticeproToastId=update-1",
  );
  assert.ok(updateSignal);
  assert.notEqual(editorKey(createAfterEdit, updateSignal), editingAKey);
  assert.equal(createAfterEdit.editingNotice, null);
  assert.equal(rows.find((row) => row.id === "a").message, "Saved custom message");
  assert.equal(rows.find((row) => row.id === "a").noticeKind, "DISPATCH");
  const reopened = await load("?edit=a");
  assert.equal(reopened.editingNotice.message, "Saved custom message");
  assert.equal(reopened.editingNotice.noticeKind, "DISPATCH");
  assert.equal(writes, 2);
});

test("success toast redirects preserve editor destination and toast parameters", () => {
  const response = redirectWithSuccessToast(
    "notice",
    "deleted",
    new URLSearchParams({ edit: "notice-a" }),
  );
  const destination = new URL(
    response.headers.get("Location"),
    "https://shop.test",
  );

  assert.equal(destination.pathname, "/app/notice");
  assert.equal(destination.searchParams.get("edit"), "notice-a");
  assert.equal(destination.searchParams.get("noticeproToast"), "notice.deleted");
  assert.match(destination.searchParams.get("noticeproToastId") ?? "", /^[\da-f-]{36}$/i);
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

test("actual Announcement, Notice, and Countdown actions persist and validate country settings", async () => {
  const routes = [
    ["../app/routes/app.announcement.tsx", "ANNOUNCEMENT"],
    ["../app/routes/app.notice.tsx", "NOTICE"],
    ["../app/routes/app.countdown.tsx", "COUNTDOWN"],
  ];

  for (const [path, type] of routes) {
    const db = makeDb();
    const created = [];
    const updates = [];
    const scopes = [];
    let existing = {
      id: "widget-1",
      status: "DRAFT",
      countryTargetingMode: "SELECTED",
      targetCountryCodes: ["GB"],
    };
    db.widget.create = async (args) => {
      created.push(args.data);
      return args;
    };
    db.widget.findFirst = async ({ where }) => {
      scopes.push(where);
      return existing;
    };
    db.widget.updateMany = async (args) => {
      updates.push(args);
      return { count: 1 };
    };

    const { mocks, state } = makeAdminMocks({
      db,
      shop: "editor.test",
      plan: "FREE",
    });
    const route = loadActualRoute(path, mocks);

    function entries({
      action = "create",
      status = "DRAFT",
      mode = "ALL",
      codes = [],
      includeCountryFields = true,
      noticeKind = "GENERAL",
    } = {}) {
      const values = {
        _action: action,
        ...(action === "update" ? { widgetId: "widget-1" } : {}),
        name: "Country rules",
        message: "Merchant-written message",
        status,
        targetingMode: "ALL",
        targetProductIds: "[]",
        targetCollectionIds: "[]",
        backgroundColor: "#111111",
        textColor: "#FFFFFF",
      };
      if (type === "NOTICE") values.noticeKind = noticeKind;
      if (type === "COUNTDOWN") {
        Object.assign(values, {
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownTimeZone: "UTC",
          countdownDesktopOffset: "0",
          countdownMobileOffset: "0",
        });
      }
      if (includeCountryFields) {
        values.countryTargetingMode = mode;
        values.targetCountryCodes = JSON.stringify(codes);
      }
      return values;
    }

    const draftResult = await route.action({
      request: await actionRequest(entries()),
    });
    assert.ok(draftResult.redirect, `${type} draft create`);
    assert.equal(created[0].status, "DRAFT");
    assert.equal(created[0].countryTargetingMode, "ALL");
    assert.deepEqual(created[0].targetCountryCodes, []);

    const activeResult = await route.action({
      request: await actionRequest(
        entries({
          status: "ACTIVE",
          mode: "SELECTED",
          codes: ["CA", "US"],
          noticeKind: "DISPATCH",
        }),
      ),
    });
    assert.ok(activeResult.redirect, `${type} first Active create`);
    assert.equal(created[1].status, "ACTIVE");
    assert.equal(created[1].countryTargetingMode, "SELECTED");
    assert.deepEqual(created[1].targetCountryCodes, ["CA", "US"]);

    const updateResult = await route.action({
      request: await actionRequest(
        entries({
          action: "update",
          mode: "SELECTED",
          codes: ["JP"],
          noticeKind: "DISPATCH",
        }),
      ),
    });
    assert.ok(updateResult.redirect, `${type} update`);
    assert.equal(updates[0].data.countryTargetingMode, "SELECTED");
    assert.deepEqual(updates[0].data.targetCountryCodes, ["JP"]);

    existing = {
      ...existing,
      countryTargetingMode: "SELECTED",
      targetCountryCodes: ["GB", "CA"],
    };
    const legacyUpdate = await route.action({
      request: await actionRequest(
        entries({ action: "update", includeCountryFields: false }),
      ),
    });
    assert.ok(legacyUpdate.redirect, `${type} legacy update`);
    assert.equal(updates[1].data.countryTargetingMode, "SELECTED");
    assert.deepEqual(updates[1].data.targetCountryCodes, ["GB", "CA"]);

    const writesBeforeInvalid = created.length + updates.length;
    const invalidSelection = await route.action({
      request: await actionRequest(
        entries({
          mode: "SELECTED",
          codes: [],
        }),
      ),
    });
    assert.match(invalidSelection.error, /Select at least one country/);
    assert.equal(invalidSelection.countryTargetingError, invalidSelection.error);
    assert.equal(created.length + updates.length, writesBeforeInvalid);

    db.widget.count = async () => 1;
    const blockedAdditionalActive = await route.action({
      request: await actionRequest(
        entries({
          status: "ACTIVE",
          mode: "SELECTED",
          codes: ["US"],
        }),
      ),
    });
    assert.match(blockedAdditionalActive.error, /Free plan allows one active/i);
    assert.equal(state.planCalls, 1);
    assert.equal(created.length + updates.length, writesBeforeInvalid);

    state.plan = "PRO";
    assert.ok(
      (
        await route.action({
          request: await actionRequest(
            entries({
              status: "ACTIVE",
              mode: "SELECTED",
              codes: ["US"],
            }),
          ),
        })
      ).redirect,
    );
    assert.deepEqual(created.at(-1).targetCountryCodes, ["US"]);

    state.planError = new Error("billing unavailable");
    const billingFailure = await route.action({
      request: await actionRequest(
        entries({
          status: "ACTIVE",
          mode: "SELECTED",
          codes: ["US"],
        }),
      ),
    });
    assert.match(billingFailure.error, /could not verify your plan/i);

    existing = null;
    const writesBeforeForeignUpdate = created.length + updates.length;
    const foreignUpdate = await route.action({
      request: await actionRequest(
        entries({
          action: "update",
          mode: "SELECTED",
          codes: ["US"],
        }),
      ),
    });
    assert.match(foreignUpdate.error, /could not be found/i);
    assert.deepEqual(scopes.at(-1), {
      shopDomain: "editor.test",
      type,
      id: "widget-1",
    });
    assert.equal(created.length + updates.length, writesBeforeForeignUpdate);

    existing = {
      id: "widget-1",
      status: "DRAFT",
      countryTargetingMode: "SELECTED",
      targetCountryCodes: ["GB"],
    };
    db.widget.updateMany = async (args) => {
      updates.push(args);
      return { count: 0 };
    };
    const zeroCountUpdate = await route.action({
      request: await actionRequest(
        entries({
          action: "update",
          mode: "SELECTED",
          codes: ["US"],
        }),
      ),
    });
    assert.match(zeroCountUpdate.error, /could not be found/i);
  }
});

test("actual Announcement, Notice, and Countdown actions reject incomplete country fields on create and update", async () => {
  const routes = [
    ["../app/routes/app.announcement.tsx", "ANNOUNCEMENT"],
    ["../app/routes/app.notice.tsx", "NOTICE"],
    ["../app/routes/app.countdown.tsx", "COUNTDOWN"],
  ];
  const incompleteCountryFields = [
    {
      description: "mode without country list",
      countryFields: { countryTargetingMode: "SELECTED" },
    },
    {
      description: "country list without mode",
      countryFields: { targetCountryCodes: JSON.stringify(["US"]) },
    },
  ];

  for (const [path, type] of routes) {
    const db = makeDb();
    const existing = {
      id: "widget-1",
      shopDomain: "editor.test",
      type,
      status: "DRAFT",
      countryTargetingMode: "SELECTED",
      targetCountryCodes: ["GB", "CA"],
    };
    const created = [];
    const updates = [];

    db.widget.findFirst = async ({ where }) => {
      assert.deepEqual(where, {
        shopDomain: "editor.test",
        type,
        id: "widget-1",
      });
      return existing;
    };
    db.widget.create = async (args) => {
      created.push(args);
      return args;
    };
    db.widget.updateMany = async (args) => {
      updates.push(args);
      Object.assign(existing, args.data);
      return { count: 1 };
    };

    const { mocks } = makeAdminMocks({ db, shop: "editor.test" });
    const route = loadActualRoute(path, mocks);

    for (const action of ["create", "update"]) {
      for (const { description, countryFields } of incompleteCountryFields) {
        const values = {
          _action: action,
          ...(action === "update" ? { widgetId: existing.id } : {}),
          name: "Country rules",
          message: "Merchant-written message",
          status: "DRAFT",
          targetingMode: "ALL",
          targetProductIds: "[]",
          targetCollectionIds: "[]",
          backgroundColor: "#111111",
          textColor: "#FFFFFF",
          ...countryFields,
        };
        if (type === "NOTICE") values.noticeKind = "GENERAL";
        if (type === "COUNTDOWN") {
          Object.assign(values, {
            countdownEndsAt: "2099-01-01T00:00:00.000Z",
            countdownTimeZone: "UTC",
            countdownDesktopOffset: "0",
            countdownMobileOffset: "0",
          });
        }

        const result = await route.action({
          request: await actionRequest(values),
        });

        assert.equal(
          result.countryTargetingError,
          "The country selection is incomplete.",
          `${type} ${action}: ${description}`,
        );
        assert.equal(result.error, result.countryTargetingError);
        assert.equal(created.length, 0, `${type} ${action}: create writes`);
        assert.equal(updates.length, 0, `${type} ${action}: update writes`);
        assert.equal(existing.countryTargetingMode, "SELECTED");
        assert.deepEqual(existing.targetCountryCodes, ["GB", "CA"]);
      }
    }
  }
});

test("Announcement and Countdown editor identities preserve errors and reset on successful mutations", () => {
  const routes = [
    {
      solution: "announcement",
      source: fs.readFileSync(
        new URL("../app/routes/app.announcement.tsx", import.meta.url),
        "utf8",
      ),
    },
    {
      solution: "countdown",
      source: fs.readFileSync(
        new URL("../app/routes/app.countdown.tsx", import.meta.url),
        "utf8",
      ),
    },
  ];

  for (const { solution, source } of routes) {
    const createSearch =
      `?noticeproToast=${solution}.created&noticeproToastId=create-1`;
    const initialKey = getWidgetEditorResetKey(null, null);
    const createSignal = getWidgetEditorMutationSignal(
      createSearch,
      solution,
    );
    const successfulCreateKey = getWidgetEditorResetKey(null, createSignal);

    assert.notEqual(successfulCreateKey, initialKey, `${solution} fresh create`);
    assert.equal(
      getWidgetEditorMutationSignal("", solution, createSignal),
      createSignal,
      `${solution} keeps reset identity after toast query cleanup`,
    );
    assert.equal(
      getWidgetEditorResetKey(
        null,
        getWidgetEditorMutationSignal("", solution, createSignal),
      ),
      successfulCreateKey,
      `${solution} error/revalidation identity stays stable`,
    );

    const updateSignal = getWidgetEditorMutationSignal(
      `?noticeproToast=${solution}.updated&noticeproToastId=update-1`,
      solution,
    );
    assert.notEqual(
      getWidgetEditorResetKey("widget-a", updateSignal),
      getWidgetEditorResetKey("widget-a", createSignal),
      `${solution} successful update resets`,
    );
    assert.notEqual(
      getWidgetEditorResetKey("widget-a", createSignal),
      getWidgetEditorResetKey("widget-b", createSignal),
      `${solution} edit destination changes reset identity`,
    );
    assert.match(source, /key=\{editorResetKey\}/);
    assert.doesNotMatch(source, /key=\{`\$\{editing(?:Widget|Countdown).+location\.key/);
  }

  const countdownSource = routes.find(
    ({ solution }) => solution === "countdown",
  ).source;
  assert.match(countdownSource, /\}, \[storedDeadline, editorResetKey\]\)/);
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
          countryTargetingMode: "ALL",
          targetCountryCodes: [],
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
          countryTargetingMode: "ALL",
          targetCountryCodes: [],
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
          countryTargetingMode: "ALL",
          targetCountryCodes: [],
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
    assert.equal(findArgs.where.shopDomain, "shop.test");
    assert.equal(findArgs.where.status, "ACTIVE");
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

test("actual proxy loaders match countries after page/schedule targeting and before the cap", async () => {
  const cases = [
    ["../app/routes/api.proxy.announcement.ts", "ANNOUNCEMENT", "announcements"],
    ["../app/routes/api.proxy.notice.ts", "NOTICE", "notices"],
    ["../app/routes/api.proxy.countdown.ts", "COUNTDOWN", "countdowns"],
  ];

  function widget({
    id,
    status = "ACTIVE",
    targetingMode = "ALL",
    targetProductIds = [],
    targetCollectionIds = [],
    countryTargetingMode = COUNTRY_TARGETING_MODES.ALL,
    targetCountryCodes = [],
  }) {
    return {
      id,
      status,
      targetingMode,
      targetProductIds,
      targetCollectionIds,
      countryTargetingMode,
      targetCountryCodes,
      message: id,
      buttonText: null,
      buttonUrl: null,
      position: "TOP",
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      dismissible: true,
      countdownEndsAt: "2099-01-01T00:00:00.000Z",
      countdownShowDays: true,
      countdownSticky: false,
      countdownDesktopOffset: 0,
      countdownMobileOffset: 0,
      countdownExpiredText: "Expired",
    };
  }

  for (const [path, type, plural] of cases) {
    const rows = [
      widget({
        id: "selected-us",
        targetingMode: "PRODUCTS",
        targetProductIds: ["gid://shopify/Product/101"],
        countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
        targetCountryCodes: ["US"],
      }),
      widget({ id: "all" }),
      widget({
        id: "selected-collection-gb",
        targetingMode: "COLLECTIONS",
        targetCollectionIds: ["gid://shopify/Collection/201"],
        countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
        targetCountryCodes: ["GB"],
      }),
      widget({
        id: "page-mismatch",
        targetingMode: "PRODUCTS",
        targetProductIds: ["gid://shopify/Product/999"],
        countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
        targetCountryCodes: ["GB"],
      }),
      widget({ id: "draft", status: "DRAFT" }),
    ];
    const db = makeDb();
    let findArgs;
    db.widget.findMany = async (args) => {
      findArgs = args;
      return rows.filter((row) => row.status === args.where.status);
    };

    let resolverCalls = 0;
    let collectionCalls = 0;
    const mocks = {
      "../shopify.server": {
        authenticate: {
          public: {
            appProxy: async () => ({ session: { shop: "proxy.test" }, admin: {} }),
          },
        },
      },
      "../db.server": { __esModule: true, default: db },
      "../features/widgets/widget.constants": {
        WIDGET_STATUSES: { ACTIVE: "ACTIVE", DRAFT: "DRAFT" },
        WIDGET_TYPES: {
          ANNOUNCEMENT: "ANNOUNCEMENT",
          NOTICE: "NOTICE",
          COUNTDOWN: "COUNTDOWN",
        },
      },
      "../features/widgets/widget.server": {
        widgetScope: (shop, widgetType) => ({ shopDomain: shop, type: widgetType }),
      },
      "../features/billing/storefront-plan.server": {
        getStorefrontWidgetLimit: async () => 2,
      },
      "../features/widgets/targeting.shared": {
        __esModule: true,
        matchesTargeting,
        readTargetingContext,
        readTargetingForm,
      },
      "../features/widgets/targeting.server": {
        getCachedMatchingCollectionIds: async (_shop, _admin, _product, ids) => {
          collectionCalls += 1;
          return ids.length ? ["gid://shopify/Collection/201"] : [];
        },
      },
      "../features/widgets/country-targeting.server": {
        filterByCountryTargeting,
      },
      "../features/widgets/country-resolution.server": {
        resolveVisitorCountry: async () => {
          resolverCalls += 1;
          return "GB";
        },
      },
    };
    const route = loadActualRoute(path, mocks);
    const baseUrl =
      "https://shop.test/apps/notice-pro?np_page=product&np_product=101";
    const multiResponse = await route.loader({
      request: new Request(`${baseUrl}&format=multi`),
    });
    const body = await multiResponse.json();

    assert.equal(findArgs.where.shopDomain, "proxy.test");
    assert.equal(findArgs.where.type, type);
    assert.equal(findArgs.where.status, "ACTIVE");
    assert.equal(findArgs.orderBy[0].createdAt, "asc");
    assert.equal(findArgs.orderBy[1].id, "asc");
    assert.equal(findArgs.where.AND.length, 2);
    assert.equal(findArgs.where.AND[0].OR[0].startsAt, null);
    assert.ok(findArgs.where.AND[0].OR[1].startsAt.lte instanceof Date);
    assert.equal(findArgs.where.AND[1].OR[0].endsAt, null);
    assert.ok(findArgs.where.AND[1].OR[1].endsAt.gte instanceof Date);
    if (type === "COUNTDOWN") {
      assert.equal(findArgs.where.countdownEndsAt.not, null);
      assert.deepEqual(Object.keys(body).sort(), ["countdowns", "serverNow"]);
    } else {
      assert.deepEqual(Object.keys(body), [plural]);
    }

    assert.equal(multiResponse.headers.get("Cache-Control"), "no-store");
    assert.equal(collectionCalls, 1);
    assert.equal(resolverCalls, 1);
    assert.deepEqual(
      body[plural].map((item) => item.message),
      ["all", "selected-collection-gb"],
    );
    for (const item of body[plural]) {
      for (const privateField of [
        "countryTargetingMode",
        "targetCountryCodes",
        "country",
        "countryCode",
        "visitorIp",
        "ip",
      ]) {
        assert.equal(Object.hasOwn(item, privateField), false);
      }
    }
    assert.doesNotMatch(
      JSON.stringify(body),
      /countryTargetingMode|targetCountryCodes|visitorIp|resolvedCountry/i,
    );

    const singleResponse = await route.loader({
      request: new Request(baseUrl),
    });
    const singleBody = await singleResponse.json();
    assert.equal(singleResponse.headers.get("Cache-Control"), "no-store");
    assert.equal(resolverCalls, 2);
    if (type === "COUNTDOWN") {
      assert.deepEqual(Object.keys(singleBody).sort(), ["countdown", "serverNow"]);
      assert.equal(singleBody.countdown.message, "all");
    } else {
      assert.equal(singleBody.message, "all");
      assert.equal("announcements" in singleBody, false);
      assert.equal("notices" in singleBody, false);
    }
  }
});

test("actual proxy loaders keep ALL on unknown or failed resolution and fail SELECTED closed", async () => {
  const cases = [
    ["../app/routes/api.proxy.announcement.ts", "ANNOUNCEMENT", "announcements"],
    ["../app/routes/api.proxy.notice.ts", "NOTICE", "notices"],
    ["../app/routes/api.proxy.countdown.ts", "COUNTDOWN", "countdowns"],
  ];

  for (const [path, type, plural] of cases) {
    for (const outcome of ["unknown", "rejected"]) {
      const db = makeDb();
      db.widget.findMany = async () => [
        {
          id: "all",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
          targetCountryCodes: [],
          message: "all",
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
          id: "selected",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
          targetCountryCodes: ["US"],
          message: "selected",
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
      ];

      let resolverCalls = 0;
      const mocks = {
        "../shopify.server": {
          authenticate: {
            public: {
              appProxy: async () => ({
                session: { shop: "proxy.test" },
                admin: {},
              }),
            },
          },
        },
        "../db.server": { __esModule: true, default: db },
        "../features/widgets/widget.constants": {
          WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
          WIDGET_TYPES: {
            ANNOUNCEMENT: "ANNOUNCEMENT",
            NOTICE: "NOTICE",
            COUNTDOWN: "COUNTDOWN",
          },
        },
        "../features/widgets/widget.server": {
          widgetScope: (shop, widgetType) => ({
            shopDomain: shop,
            type: widgetType,
          }),
        },
        "../features/billing/storefront-plan.server": {
          getStorefrontWidgetLimit: async () => 10,
        },
        "../features/widgets/targeting.shared": {
          __esModule: true,
          matchesTargeting,
          readTargetingContext,
          readTargetingForm,
        },
        "../features/widgets/targeting.server": {
          getCachedMatchingCollectionIds: async () => [],
        },
        "../features/widgets/country-targeting.server": {
          filterByCountryTargeting,
        },
        "../features/widgets/country-resolution.server": {
          resolveVisitorCountry: async () => {
            resolverCalls += 1;
            if (outcome === "rejected") {
              throw new Error("synthetic resolver failure");
            }
            return null;
          },
        },
      };
      const route = loadActualRoute(path, mocks);
      const originalConsoleError = console.error;
      const errors = [];
      console.error = (...args) => errors.push(args.join(" "));

      try {
        const response = await route.loader({
          request: new Request(
            "https://shop.test/apps/notice-pro?format=multi",
          ),
        });
        const body = await response.json();

        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal(resolverCalls, 1);
        assert.deepEqual(body[plural].map((item) => item.message), ["all"]);
        assert.doesNotMatch(
          JSON.stringify(body),
          /countryTargetingMode|targetCountryCodes|visitorIp|resolvedCountry/i,
        );
        if (type === "COUNTDOWN") assert.ok(body.serverNow);
        assert.equal(
          errors.length,
          outcome === "rejected" ? 1 : 0,
        );
        if (outcome === "rejected") {
          assert.match(errors[0], /country resolution failed/i);
          assert.doesNotMatch(errors[0], /synthetic resolver failure|US/);
        }
      } finally {
        console.error = originalConsoleError;
      }
    }
  }
});

test("signed country assertions work through all three proxy actions and invalid assertions keep ALL", async () => {
  const savedEnvironment = {
    enabled: process.env.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED,
    secret: process.env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET,
    workerUrl: process.env.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL,
  };
  const secret = "b".repeat(64);
  const shop = "noticepro-proxy-test.myshopify.com";
  const now = Date.now();
  process.env.NOTICEPRO_COUNTRY_ATTESTATION_ENABLED = "true";
  process.env.NOTICEPRO_COUNTRY_ATTESTATION_SECRET = secret;
  process.env.NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL =
    "https://worker.test/attest";

  try {
    const challenge = issueCountryChallenge(shop, secret, now);
    const worker = createCountryAttestationWorker(() => now);
    const workerRequest = new Request("https://worker.test/attest", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: challenge,
    });
    Object.defineProperty(workerRequest, "cf", { value: { country: "US" } });
    const signedResponse = await worker.fetch(workerRequest, {
      NOTICEPRO_COUNTRY_ATTESTATION_SECRET: secret,
    });
    const { assertion } = await signedResponse.json();
    const wrongShopChallenge = issueCountryChallenge(
      "different-shop.myshopify.com",
      secret,
      now,
    );
    const wrongShopRequest = new Request("https://worker.test/attest", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: wrongShopChallenge,
    });
    Object.defineProperty(wrongShopRequest, "cf", {
      value: { country: "US" },
    });
    const wrongShopResponse = await worker.fetch(wrongShopRequest, {
      NOTICEPRO_COUNTRY_ATTESTATION_SECRET: secret,
    });
    const { assertion: wrongShopAssertion } = await wrongShopResponse.json();

    const cases = [
      ["../app/routes/api.proxy.announcement.ts", "ANNOUNCEMENT", "announcements"],
      ["../app/routes/api.proxy.notice.ts", "NOTICE", "notices"],
      ["../app/routes/api.proxy.countdown.ts", "COUNTDOWN", "countdowns"],
    ];

    for (const [path, type, plural] of cases) {
      const db = makeDb();
      db.widget.findMany = async () => [
        {
          id: "all",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          countryTargetingMode: "ALL",
          targetCountryCodes: [],
          message: "all",
          buttonText: null,
          buttonUrl: null,
          position: "TOP",
          backgroundColor: "#111111",
          textColor: "#FFFFFF",
          dismissible: true,
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownShowDays: true,
          countdownSticky: false,
          countdownDesktopOffset: 0,
          countdownMobileOffset: 0,
          countdownExpiredText: "Expired",
        },
        {
          id: "selected",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          countryTargetingMode: "SELECTED",
          targetCountryCodes: ["US"],
          message: "selected",
          buttonText: null,
          buttonUrl: null,
          position: "TOP",
          backgroundColor: "#222222",
          textColor: "#FFFFFF",
          dismissible: true,
          countdownEndsAt: "2099-01-01T00:00:00.000Z",
          countdownShowDays: true,
          countdownSticky: false,
          countdownDesktopOffset: 0,
          countdownMobileOffset: 0,
          countdownExpiredText: "Expired",
        },
      ];

      const mocks = {
        "../shopify.server": {
          authenticate: {
            public: {
              appProxy: async () => ({ session: { shop }, admin: {} }),
            },
          },
        },
        "../db.server": { __esModule: true, default: db },
        "../features/widgets/widget.constants": {
          WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
          WIDGET_TYPES: {
            ANNOUNCEMENT: "ANNOUNCEMENT",
            NOTICE: "NOTICE",
            COUNTDOWN: "COUNTDOWN",
          },
        },
        "../features/widgets/widget.server": {
          widgetScope: (shopDomain, widgetType) => ({
            shopDomain,
            type: widgetType,
          }),
        },
        "../features/billing/storefront-plan.server": {
          getStorefrontWidgetLimit: async () => 10,
        },
        "../features/widgets/targeting.shared": {
          __esModule: true,
          matchesTargeting,
          readTargetingContext,
          readTargetingForm,
        },
        "../features/widgets/targeting.server": {
          getCachedMatchingCollectionIds: async () => [],
        },
        "../features/widgets/country-targeting.server": {
          filterByCountryTargeting,
        },
        "../features/widgets/country-resolution.server": {
          resolveVisitorCountry,
        },
      };
      const route = loadActualRoute(path, mocks);
      const url =
        "https://storefront.test/apps/noticepro/widget?format=multi&np_page=other";
      const requestFor = (payload) =>
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

      const validResponse = await route.action({
        request: requestFor({ challenge, assertion }),
      });
      const validBody = await validResponse.json();
      assert.equal(validResponse.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(
        validBody[plural].map(({ message }) => message),
        ["all", "selected"],
      );
      assert.equal("countryTargetingMode" in validBody[plural][0], false);

      const invalidResponse = await route.action({
        request: requestFor({
          challenge: wrongShopChallenge,
          assertion: wrongShopAssertion,
        }),
      });
      const invalidBody = await invalidResponse.json();
      assert.deepEqual(
        invalidBody[plural].map(({ message }) => message),
        ["all"],
      );
      assert.doesNotMatch(
        JSON.stringify(invalidBody),
        /198\.51\.100|192\.0\.2|countryTargetingMode|targetCountryCodes/i,
      );
      if (type === "COUNTDOWN") {
        assert.ok(validBody.serverNow);
        assert.ok(invalidBody.serverNow);
      }
    }
  } finally {
    for (const [name, value] of [
      ["NOTICEPRO_COUNTRY_ATTESTATION_ENABLED", savedEnvironment.enabled],
      ["NOTICEPRO_COUNTRY_ATTESTATION_SECRET", savedEnvironment.secret],
      ["NOTICEPRO_COUNTRY_ATTESTATION_WORKER_URL", savedEnvironment.workerUrl],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("actual proxy loaders skip resolution when no page-eligible selection needs it", async () => {
  const cases = [
    ["../app/routes/api.proxy.announcement.ts", "ANNOUNCEMENT"],
    ["../app/routes/api.proxy.notice.ts", "NOTICE"],
    ["../app/routes/api.proxy.countdown.ts", "COUNTDOWN"],
  ];

  for (const [path, type] of cases) {
    for (const rows of [
      [
        {
          id: "all",
          targetingMode: "ALL",
          targetProductIds: [],
          targetCollectionIds: [],
          countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
          targetCountryCodes: [],
          message: "all",
        },
      ],
      [
        {
          id: "page-mismatch",
          targetingMode: "PRODUCTS",
          targetProductIds: ["gid://shopify/Product/999"],
          targetCollectionIds: [],
          countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
          targetCountryCodes: ["US"],
          message: "not eligible",
        },
      ],
    ]) {
      const db = makeDb();
      db.widget.findMany = async () => rows;
      let resolverCalls = 0;
      const mocks = {
        "../shopify.server": {
          authenticate: {
            public: {
              appProxy: async () => ({ session: { shop: "proxy.test" }, admin: {} }),
            },
          },
        },
        "../db.server": { __esModule: true, default: db },
        "../features/widgets/widget.constants": {
          WIDGET_STATUSES: { ACTIVE: "ACTIVE" },
          WIDGET_TYPES: {
            ANNOUNCEMENT: "ANNOUNCEMENT",
            NOTICE: "NOTICE",
            COUNTDOWN: "COUNTDOWN",
          },
        },
        "../features/widgets/widget.server": {
          widgetScope: (shop, widgetType) => ({
            shopDomain: shop,
            type: widgetType,
          }),
        },
        "../features/billing/storefront-plan.server": {
          getStorefrontWidgetLimit: async () => 10,
        },
        "../features/widgets/targeting.shared": {
          __esModule: true,
          matchesTargeting,
          readTargetingContext,
          readTargetingForm,
        },
        "../features/widgets/targeting.server": {
          getCachedMatchingCollectionIds: async () => [],
        },
        "../features/widgets/country-targeting.server": {
          filterByCountryTargeting,
        },
        "../features/widgets/country-resolution.server": {
          resolveVisitorCountry: async () => {
            resolverCalls += 1;
            return "US";
          },
        },
      };
      const route = loadActualRoute(path, mocks);
      const requestUrl =
        rows[0].targetingMode === "PRODUCTS"
          ? "https://shop.test/apps/notice-pro?np_page=product&np_product=101"
          : "https://shop.test/apps/notice-pro";

      await route.loader({ request: new Request(requestUrl) });
      assert.equal(resolverCalls, 0);
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
    let resolutionCalls = 0;
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
      "../features/widgets/country-resolution.server": {
        resolveVisitorCountry: async () => {
          resolutionCalls += 1;
          return "US";
        },
      },
    };
    const route = loadActualRoute(path, mocks);
    const response = await route.loader({
      request: new Request("https://shop.test/apps/notice-pro"),
    });
    assert.equal(response.status, 401);
    assert.equal(dbCalls, 0);
    assert.equal(resolutionCalls, 0);
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
        countryTargetingMode: "ALL",
        targetCountryCodes: [],
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
        countryTargetingMode: "ALL",
        targetCountryCodes: [],
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
        countryTargetingMode: "ALL",
        targetCountryCodes: [],
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

import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useLocation,
} from "react-router";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";

import {
  NOTICE_KINDS,
  WIDGET_STATUSES,
  WIDGET_TYPES,
} from "../features/widgets/widget.constants";
import {
  activeWidgetScope,
  widgetIdScope,
  widgetScope,
} from "../features/widgets/widget.server";
import LoadingSubmitButton from "../components/LoadingSubmitButton";
import { redirectWithSuccessToast } from "../features/widgets/success-toast.server";
import { getAuthenticatedAppPlan } from "../features/billing/admin-plan.server";
import {
  canActivateAnotherWidget,
  type AppPlan,
} from "../features/billing/plan-policy.server";
import WidgetTargetingFields from "../features/widgets/WidgetTargetingFields";
import {
  getNoticeEditorMutationSignal,
  getNoticeEditorResetKey,
} from "../features/widgets/notice-editor-reset";
import { readTargetingForm } from "../features/widgets/targeting.shared";
import { readCountryTargetingForm } from "../features/widgets/country-targeting.shared";
import WidgetCountryTargetingFields from "../features/widgets/WidgetCountryTargetingFields";
import { verifyTargetingSelection } from "../features/widgets/targeting.server";
import { getShopScheduleTimeZone } from "../features/widgets/scheduling.server";
import {
  formatSchedule,
  parseScheduleInputPreservingInstant,
  toScheduleInput,
} from "../features/widgets/scheduling.shared";

const DISPATCH_EXAMPLE =
  "Made to order. Usually dispatches within 1–2 business days.";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  let plan: AppPlan | null = null;

  try {
    plan = await getAuthenticatedAppPlan(admin, session.shop);
  } catch {
    console.warn("NoticePro Notice plan verification unavailable.");
  }

  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");

  const notices = await db.widget.findMany({
    where: widgetScope(session.shop, WIDGET_TYPES.NOTICE),

    orderBy: {
      createdAt: "desc",
    },
  });

  const editingNotice = editId
    ? await db.widget.findFirst({
        where: widgetIdScope(session.shop, WIDGET_TYPES.NOTICE, editId),
      })
    : null;

  return {
    notices,
    editingNotice,
    plan,
    storeTimeZone: await getShopScheduleTimeZone(admin),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const actionType = String(formData.get("_action") || "create");
  const widgetId = String(formData.get("widgetId") || "");

  if (!["create", "update", "delete"].includes(actionType)) {
    return { error: "Invalid Notice action." };
  }

  if (actionType === "delete") {
    if (!widgetId) {
      return {
        error: "The notice could not be found.",
      };
    }

    const deleted = await db.widget.deleteMany({
      where: widgetIdScope(session.shop, WIDGET_TYPES.NOTICE, widgetId),
    });

    if (deleted.count === 0) {
      return { error: "The notice could not be found." };
    }

    const editId = new URL(request.url).searchParams.get("edit");
    const preservedSearchParams =
      editId && editId !== widgetId
        ? new URLSearchParams({ edit: editId })
        : undefined;

    return redirectWithSuccessToast("notice", "deleted", preservedSearchParams);
  }

  const name = String(formData.get("name") || "").trim();
  const message = String(formData.get("message") || "").trim();
  const buttonText = String(formData.get("buttonText") || "").trim();
  const buttonUrl = String(formData.get("buttonUrl") || "").trim();
  const backgroundColor = String(formData.get("backgroundColor") || "#FEF3C7");
  const textColor = String(formData.get("textColor") || "#111827");
  const status = String(formData.get("status") || "DRAFT");
  const dismissible = formData.get("dismissible") === "on";
  const submittedNoticeKind = formData.get("noticeKind");
  const noticeKind =
    submittedNoticeKind === null ? NOTICE_KINDS.GENERAL : submittedNoticeKind;

  if (!name) {
    return {
      error: "Please enter a notice name.",
    };
  }

  if (!message) {
    return {
      error: "Please enter the notice message.",
    };
  }

  if (status !== WIDGET_STATUSES.DRAFT && status !== WIDGET_STATUSES.ACTIVE) {
    return { error: "Please choose Draft or Active." };
  }

  if (
    noticeKind !== NOTICE_KINDS.GENERAL &&
    noticeKind !== NOTICE_KINDS.DISPATCH
  ) {
    return { error: "Please choose a valid Notice kind." };
  }

  let existingNotice: Awaited<ReturnType<typeof db.widget.findFirst>> = null;
  if (actionType === "update") {
    if (!widgetId) {
      return {
        error: "The notice could not be found.",
      };
    }

    existingNotice = await db.widget.findFirst({
      where: widgetIdScope(session.shop, WIDGET_TYPES.NOTICE, widgetId),
    });

    if (!existingNotice) {
      return {
        error: "The notice could not be found.",
      };
    }
  }

  const scheduleTimeZone = await getShopScheduleTimeZone(admin);

  if (!scheduleTimeZone) {
    return {
      error: "Store timezone is unavailable. Reload and try again.",
    };
  }

  if (
    String(formData.get("scheduleTimeZone") || "") !== scheduleTimeZone ||
    !formData.has("startsAt") ||
    !formData.has("endsAt")
  ) {
    return {
      error:
        "The store timezone changed or this form is outdated. Reload before saving.",
    };
  }

  const startResult = parseScheduleInputPreservingInstant(
    String(formData.get("startsAt") || "").trim(),
    scheduleTimeZone,
    existingNotice?.startsAt,
  );

  if (!startResult.ok) {
    return { error: `Start time: ${startResult.error}` };
  }

  const endResult = parseScheduleInputPreservingInstant(
    String(formData.get("endsAt") || "").trim(),
    scheduleTimeZone,
    existingNotice?.endsAt,
  );

  if (!endResult.ok) {
    return { error: `End time: ${endResult.error}` };
  }

  const startsAt = startResult.date;
  const endsAt = endResult.date;

  if (startsAt && endsAt && endsAt <= startsAt) {
    return {
      error: "The end date must be after the start date.",
    };
  }

  const targeting = readTargetingForm(formData);

  if (!targeting.ok) {
    return { error: targeting.error };
  }

  const targetingVerification = await verifyTargetingSelection(
    admin,
    targeting.data,
  );

  if (!targetingVerification.ok) {
    return { error: targetingVerification.error };
  }

  const countryTargeting = readCountryTargetingForm(formData, existingNotice);

  if (!countryTargeting.ok) {
    return {
      error: countryTargeting.error,
      countryTargetingError: countryTargeting.error,
    };
  }

  if (status === "ACTIVE") {
    const activeWidgetCount = await db.widget.count({
      where: activeWidgetScope(
        session.shop,
        WIDGET_TYPES.NOTICE,
        actionType === "update" && widgetId ? widgetId : undefined,
      ),
    });

    if (activeWidgetCount >= 1) {
      let plan: AppPlan;

      try {
        plan = await getAuthenticatedAppPlan(admin, session.shop);
      } catch {
        return {
          error:
            "We could not verify your plan. Please try again, or save this Notice as a draft.",
        };
      }

      if (!canActivateAnotherWidget(plan, activeWidgetCount)) {
        return {
          error:
            "The Free plan allows one active Notice. Save this one as a draft or deactivate your current Notice first.",
        };
      }
    }
  }

  const noticeData = {
    ...targeting.data,
    ...countryTargeting.data,
    type: WIDGET_TYPES.NOTICE,
    noticeKind,
    name,
    status,
    message,
    buttonText: buttonText || null,
    buttonUrl: buttonUrl || null,
    position: "TOP",
    backgroundColor,
    textColor,
    dismissible,
    startsAt,
    endsAt,
  };

  if (actionType === "update") {
    const updated = await db.widget.updateMany({
      where: widgetIdScope(session.shop, WIDGET_TYPES.NOTICE, widgetId),
      data: noticeData,
    });

    if (updated.count === 0) {
      return { error: "The notice could not be found." };
    }
  } else {
    await db.widget.create({
      data: {
        shopDomain: session.shop,
        ...noticeData,
      },
    });
  }

  return redirectWithSuccessToast(
    "notice",
    actionType === "update" ? "updated" : "created",
  );
}

export default function NoticePage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const currentMutationSignal = getNoticeEditorMutationSignal(location.search);
  const [lastMutationSignal, setLastMutationSignal] = useState(
    currentMutationSignal,
  );
  const resetSignal = getNoticeEditorMutationSignal(
    location.search,
    lastMutationSignal,
  );
  const editorResetKey = getNoticeEditorResetKey(
    loaderData.editingNotice?.id ?? null,
    resetSignal,
  );

  useEffect(() => {
    if (currentMutationSignal) {
      setLastMutationSignal(currentMutationSignal);
    }
  }, [currentMutationSignal]);

  return (
    <NoticePageContent
      key={editorResetKey}
      {...loaderData}
      actionError={actionData?.error}
      countryTargetingError={actionData?.countryTargetingError}
    />
  );
}

type NoticePageContentProps = Awaited<ReturnType<typeof loader>> & {
  actionError?: string;
  countryTargetingError?: string;
};

function NoticePageContent({
  notices,
  editingNotice,
  plan,
  storeTimeZone,
  actionError,
  countryTargetingError,
}: NoticePageContentProps) {
  const [editorNotice] = useState(editingNotice);
  const [scheduleTimeZone] = useState(storeTimeZone);
  const isEditing = Boolean(editorNotice);
  const [message, setMessage] = useState(editorNotice?.message ?? "");
  const [noticeKind, setNoticeKind] = useState(
    editorNotice?.noticeKind === NOTICE_KINDS.DISPATCH
      ? NOTICE_KINDS.DISPATCH
      : NOTICE_KINDS.GENERAL,
  );

  return (
    <s-page heading="Notice">
      {actionError ? (
        <s-banner tone="critical" heading="Couldn't save notice">
          {actionError}
        </s-banner>
      ) : null}

      <s-section heading={isEditing ? "Edit notice" : "Create notice"}>
        <div style={{ display: "grid", gap: "16px" }}>
          <p>
            Create a notice for your storefront. You can preview saved notices
            below.
          </p>

          <s-banner
            tone="info"
            heading={
              plan === "PRO"
                ? "Pro plan: unlimited active widgets"
                : plan === "FREE"
                  ? "Free plan: one Active Notice total"
                  : "Plan verification unavailable"
            }
          >
            {plan === "PRO"
              ? "You can activate multiple Announcements, Notices, and Countdowns. Notices display together within the Notice app block."
              : plan === "FREE"
                ? "General and Dispatch Notices share the same one-Active-Notice allowance. Save additional Notices as drafts or deactivate the current Active Notice first."
                : "We could not verify your current plan. Refresh to retry. Draft saves and deletion remain available; additional Active saves require successful server-side plan verification."}
          </s-banner>

          <Form method="post">
            <input
              type="hidden"
              name="_action"
              value={isEditing ? "update" : "create"}
            />

            {editorNotice ? (
              <input type="hidden" name="widgetId" value={editorNotice.id} />
            ) : null}

            <div
              style={{
                display: "grid",
                gap: "16px",
                maxWidth: "720px",
              }}
            >
              <s-text-field
                label="Notice name"
                name="name"
                placeholder="Important delivery notice"
                defaultValue={editorNotice?.name ?? ""}
                required
              />

              <label>
                Notice kind
                <select
                  name="noticeKind"
                  value={noticeKind}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (
                      value === NOTICE_KINDS.GENERAL ||
                      value === NOTICE_KINDS.DISPATCH
                    ) {
                      setNoticeKind(value);
                    }
                  }}
                  style={{
                    display: "block",
                    boxSizing: "border-box",
                    width: "100%",
                    marginTop: "6px",
                    padding: "10px",
                  }}
                >
                  <option value={NOTICE_KINDS.GENERAL}>General notice</option>
                  <option value={NOTICE_KINDS.DISPATCH}>Dispatch notice</option>
                </select>
              </label>

              <label>
                Notice message
                <textarea
                  name="message"
                  placeholder="Orders may take an extra day during the holiday period."
                  rows={4}
                  value={message}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                  required
                  style={{
                    display: "block",
                    boxSizing: "border-box",
                    width: "100%",
                    marginTop: "6px",
                    padding: "10px",
                    border: "1px solid #8c9196",
                    borderRadius: "8px",
                  }}
                />
                {noticeKind === NOTICE_KINDS.DISPATCH ? (
                  <>
                    <p style={{ margin: "6px 0" }}>
                      Dispatch means leaving your business, not arrival at the
                      customer. Use an estimate; do not promise a delivery date.
                    </p>
                    <button
                      type="button"
                      onClick={() => setMessage(DISPATCH_EXAMPLE)}
                    >
                      Use dispatch example
                    </button>
                  </>
                ) : null}
              </label>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "16px",
                }}
              >
                <s-text-field
                  label="Button text, optional"
                  name="buttonText"
                  placeholder="Learn more"
                  defaultValue={editorNotice?.buttonText ?? ""}
                />

                <label>
                  Button URL, optional
                  <input
                    name="buttonUrl"
                    type="url"
                    placeholder="https://your-store.com/pages/shipping"
                    defaultValue={editorNotice?.buttonUrl ?? ""}
                    style={{
                      display: "block",
                      boxSizing: "border-box",
                      width: "100%",
                      marginTop: "6px",
                      padding: "10px",
                      border: "1px solid #8c9196",
                      borderRadius: "8px",
                    }}
                  />
                </label>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "16px",
                }}
              >
                <label>
                  Background color
                  <input
                    name="backgroundColor"
                    type="color"
                    defaultValue={editorNotice?.backgroundColor ?? "#FEF3C7"}
                    style={{ display: "block", marginTop: "6px" }}
                  />
                </label>

                <label>
                  Text color
                  <input
                    name="textColor"
                    type="color"
                    defaultValue={editorNotice?.textColor ?? "#111827"}
                    style={{ display: "block", marginTop: "6px" }}
                  />
                </label>
              </div>

              <s-checkbox
                name="dismissible"
                value="on"
                label="Allow visitors to close the notice"
                defaultChecked={editorNotice?.dismissible ?? true}
              />
              <input
                type="hidden"
                name="scheduleTimeZone"
                value={scheduleTimeZone ?? ""}
              />

              <p style={{ margin: 0 }}>
                {scheduleTimeZone
                  ? `Optional schedule. Enter times in your store timezone: ${scheduleTimeZone}. Leave both fields empty for no schedule limits.`
                  : "Store timezone is unavailable. Reload before saving."}
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "16px",
                }}
              >
                <label>
                  Starts at, optional
                  <input
                    name="startsAt"
                    type="datetime-local"
                    step={1}
                    disabled={!scheduleTimeZone}
                    defaultValue={
                      scheduleTimeZone
                        ? toScheduleInput(
                            editorNotice?.startsAt,
                            scheduleTimeZone,
                          )
                        : ""
                    }
                    style={{
                      display: "block",
                      boxSizing: "border-box",
                      width: "100%",
                      marginTop: "6px",
                      padding: "10px",
                      border: "1px solid #8c9196",
                      borderRadius: "8px",
                      font: "inherit",
                    }}
                  />
                </label>

                <label>
                  Ends at, optional
                  <input
                    name="endsAt"
                    type="datetime-local"
                    step={1}
                    disabled={!scheduleTimeZone}
                    defaultValue={
                      scheduleTimeZone
                        ? toScheduleInput(
                            editorNotice?.endsAt,
                            scheduleTimeZone,
                          )
                        : ""
                    }
                    style={{
                      display: "block",
                      boxSizing: "border-box",
                      width: "100%",
                      marginTop: "6px",
                      padding: "10px",
                      border: "1px solid #8c9196",
                      borderRadius: "8px",
                      font: "inherit",
                    }}
                  />
                </label>
              </div>
              <WidgetTargetingFields
                initialValue={{
                  targetingMode:
                    editorNotice?.targetingMode === "PRODUCTS"
                      ? "PRODUCTS"
                      : editorNotice?.targetingMode === "COLLECTIONS"
                        ? "COLLECTIONS"
                        : "ALL",
                  targetProductIds: editorNotice?.targetProductIds ?? [],
                  targetCollectionIds: editorNotice?.targetCollectionIds ?? [],
                }}
              />
              <WidgetCountryTargetingFields
                initialValue={{
                  countryTargetingMode:
                    editorNotice?.countryTargetingMode ?? "ALL",
                  targetCountryCodes: editorNotice?.targetCountryCodes ?? [],
                }}
                error={countryTargetingError}
              />
              <s-select
                label="Save as"
                name="status"
                value={editorNotice?.status ?? "DRAFT"}
              >
                <s-option value="DRAFT">Draft</s-option>
                <s-option value="ACTIVE">Active</s-option>
              </s-select>

              <div
                style={{ display: "flex", gap: "12px", alignItems: "center" }}
              >
                <LoadingSubmitButton
                  label={isEditing ? "Update notice" : "Save notice"}
                  pendingLabel={isEditing ? "Saving…" : "Creating…"}
                />

                {isEditing ? <Link to="/app/notice">Cancel</Link> : null}
              </div>
            </div>
          </Form>
        </div>
      </s-section>

      <s-section heading="Your notices">
        {notices.length === 0 ? (
          <p>No notices yet. Use the form above to create your first one.</p>
        ) : (
          <div style={{ display: "grid", gap: "16px" }}>
            {notices.map((notice) => (
              <div
                key={notice.id}
                style={{
                  display: "grid",
                  gap: "12px",
                  padding: "16px",
                  border: "1px solid #d1d5db",
                  borderRadius: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{notice.name}</strong>
                  <s-badge>
                    {notice.noticeKind === NOTICE_KINDS.DISPATCH
                      ? "Dispatch notice"
                      : "General notice"}
                  </s-badge>
                  <s-badge
                    color={notice.status === "ACTIVE" ? "strong" : "base"}
                  >
                    {notice.status}
                  </s-badge>
                </div>

                <p style={{ margin: 0 }}>{notice.message}</p>

                {notice.startsAt || notice.endsAt ? (
                  <div
                    style={{
                      padding: "12px",
                      backgroundColor: "#f3f4f6",
                      color: "#111827",
                      borderRadius: "8px",
                    }}
                  >
                    <strong>
                      Schedule ({storeTimeZone ?? "timezone unavailable"})
                    </strong>

                    <p style={{ margin: "6px 0 0" }}>
                      Starts:{" "}
                      {notice.startsAt
                        ? storeTimeZone
                          ? formatSchedule(notice.startsAt, storeTimeZone)
                          : "Store timezone unavailable"
                        : "No start limit"}
                    </p>

                    <p style={{ margin: "4px 0 0" }}>
                      Ends:{" "}
                      {notice.endsAt
                        ? storeTimeZone
                          ? formatSchedule(notice.endsAt, storeTimeZone)
                          : "Store timezone unavailable"
                        : "No end limit"}
                    </p>
                  </div>
                ) : null}

                <div>
                  <strong>Storefront preview</strong>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      flexWrap: "wrap",
                      marginTop: "8px",
                      padding: "14px 18px",
                      backgroundColor: notice.backgroundColor,
                      color: notice.textColor,
                      borderRadius: "8px",
                    }}
                  >
                    <span>{notice.message}</span>

                    {notice.buttonText && notice.buttonUrl ? (
                      <a
                        href={notice.buttonUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: "inline-block",
                          padding: "6px 12px",
                          color: notice.backgroundColor,
                          backgroundColor: notice.textColor,
                          borderRadius: "4px",
                          textDecoration: "none",
                        }}
                      >
                        {notice.buttonText}
                      </a>
                    ) : null}
                  </div>
                </div>

                <div
                  style={{ display: "flex", gap: "12px", alignItems: "center" }}
                >
                  <Link to={`?edit=${notice.id}`}>Edit</Link>

                  <Form method="post">
                    <input type="hidden" name="_action" value="delete" />
                    <input type="hidden" name="widgetId" value={notice.id} />
                    <LoadingSubmitButton
                      intent="delete"
                      widgetId={notice.id}
                      label="Delete"
                      pendingLabel="Deleting…"
                    />
                  </Form>
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

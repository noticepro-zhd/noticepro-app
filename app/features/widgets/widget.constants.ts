export const WIDGET_TYPES = {
  ANNOUNCEMENT: "ANNOUNCEMENT",
  NOTICE: "NOTICE",
  COUNTDOWN: "COUNTDOWN",
} as const;

export type WidgetType = (typeof WIDGET_TYPES)[keyof typeof WIDGET_TYPES];

export const WIDGET_STATUSES = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
} as const;

export type WidgetStatus =
  (typeof WIDGET_STATUSES)[keyof typeof WIDGET_STATUSES];

export const NOTICE_KINDS = {
  GENERAL: "GENERAL",
  DISPATCH: "DISPATCH",
} as const;

export type NoticeKind = (typeof NOTICE_KINDS)[keyof typeof NOTICE_KINDS];

const RESETTING_NOTICE_TOASTS = new Set([
  "notice.created",
  "notice.updated",
]);

export function getNoticeEditorMutationSignal(
  search: string,
  previousSignal: string | null = null,
): string | null {
  const params = new URLSearchParams(search);
  const toast = params.get("noticeproToast");
  const toastId = params.get("noticeproToastId");

  if (!toast || !RESETTING_NOTICE_TOASTS.has(toast) || !toastId) {
    return previousSignal;
  }

  return `${toast}:${toastId}`;
}

export function getNoticeEditorResetKey(
  editingNoticeId: string | null,
  mutationSignal: string | null,
): string {
  const destination =
    editingNoticeId === null ? "create" : `edit:${editingNoticeId}`;

  return `${destination}:${mutationSignal ?? ""}`;
}

export type WidgetEditorSolution = "announcement" | "countdown";

export function getWidgetEditorMutationSignal(
  search: string,
  solution: WidgetEditorSolution,
  previousSignal: string | null = null,
): string | null {
  const params = new URLSearchParams(search);
  const toast = params.get("noticeproToast");
  const toastId = params.get("noticeproToastId");

  if (
    (toast !== `${solution}.created` && toast !== `${solution}.updated`) ||
    !toastId
  ) {
    return previousSignal;
  }

  return `${toast}:${toastId}`;
}

export function getWidgetEditorResetKey(
  editingWidgetId: string | null,
  mutationSignal: string | null,
): string {
  const destination =
    editingWidgetId === null ? "create" : `edit:${editingWidgetId}`;

  return `${destination}:${mutationSignal ?? ""}`;
}

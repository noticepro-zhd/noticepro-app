import { randomUUID } from "node:crypto";
import { redirect } from "react-router";

type Solution = "announcement" | "notice" | "countdown";
type Operation = "created" | "updated" | "deleted";

export function redirectWithSuccessToast(
  solution: Solution,
  operation: Operation,
  preservedSearchParams?: URLSearchParams,
) {
  const params = new URLSearchParams(preservedSearchParams);
  params.set("noticeproToast", `${solution}.${operation}`);
  params.set("noticeproToastId", randomUUID());

  return redirect(`/app/${solution}?${params.toString()}`);
}

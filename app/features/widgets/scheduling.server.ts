import type { authenticate } from "../../shopify.server";
import { isValidScheduleTimeZone } from "./scheduling.shared";

type AuthenticatedAdmin = Awaited<
  ReturnType<typeof authenticate.admin>
>["admin"];

export async function getShopScheduleTimeZone(
  admin: AuthenticatedAdmin,
): Promise<string | null> {
  try {
    const response = await admin.graphql(
      `#graphql
        query NoticeProScheduleTimeZone {
          shop {
            ianaTimezone
          }
        }
      `,
    );

    if (!response.ok) return null;

    const body: unknown = await response.json();

    if (typeof body !== "object" || body === null) return null;

    const result = body as {
      errors?: unknown;
      data?: {
        shop?: {
          ianaTimezone?: unknown;
        };
      };
    };

    if (result.errors !== undefined) {
      if (!Array.isArray(result.errors) || result.errors.length > 0) {
        return null;
      }
    }

    const timeZone = result.data?.shop?.ianaTimezone;

    if (typeof timeZone !== "string" || !isValidScheduleTimeZone(timeZone)) {
      return null;
    }

    return timeZone;
  } catch {
    // Do not log responses, credentials or authenticated request URLs.
    return null;
  }
}

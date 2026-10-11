import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  let stage = "authenticate";

  try {
    const { shop, topic } = await authenticate.webhook(request);

    stage = "delete sessions";

    // Safe when no matching sessions remain, including repeated deliveries.
    await db.session.deleteMany({
      where: { shop },
    });

    console.log(`Processed ${topic} webhook for ${shop}`);

    return new Response(null, { status: 200 });
  } catch (error) {
    // Preserve SDK rejection responses rather than acknowledge invalid requests.
    if (error instanceof Response) {
      throw error;
    }

    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;

    console.error("NoticePro uninstall webhook processing failed", {
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      code,
    });

    return new Response("Webhook processing failed", { status: 500 });
  }
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { productIds } = await request.json();

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return Response.json(
        { error: "Missing productIds" },
        { status: 400 }
      );
    }

    const updated: string[] = [];
    const failed: any[] = [];

    for (const id of productIds) {
      const res = await admin.graphql(
        `#graphql
        mutation setConnect($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "custom",
                key: "sync_status",
                type: "boolean",
                value: "true",
              },
            ],
          },
        }
      );

      const json = await res.json();
      const errors = json?.data?.metafieldsSet?.userErrors;

      if (errors?.length) {
        failed.push({ id, errors });
      } else {
        updated.push(id);
      }
    }

    return Response.json({
      success: true,
      connected: updated,
      failed,
    });

  } catch (error) {
    return Response.json(
      { error: "Unexpected server error", details: String(error) },
      { status: 500 }
    );
  }
};

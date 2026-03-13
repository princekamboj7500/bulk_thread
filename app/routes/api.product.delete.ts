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

    const deleted: string[] = [];
    const failed: any[] = [];

    for (const id of productIds) {
      const deleteRes = await admin.graphql(
        `#graphql
        mutation deleteProduct($id: ID!) {
          productDelete(input: { id: $id }) {
            deletedProductId
            userErrors { field message }
          }
        }`,
        { variables: { id } }
      );

      const deleteJson = await deleteRes.json();
      const errors = deleteJson?.data?.productDelete?.userErrors;

      if (errors?.length) {
        failed.push({ id, errors });
      } else {
        deleted.push(deleteJson.data.productDelete.deletedProductId);
      }
    }

    return Response.json({
      success: true,
      deleted,
      failed,
    });

  } catch (error) {
    return Response.json(
      { error: "Unexpected server error", details: String(error) },
      { status: 500 }
    );
  }
};

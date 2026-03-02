import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { productId } = await request.json();

    if (!productId) {
      return Response.json(
        { error: "Missing productId" },
        { status: 400 }
      );
    }

    const deleteRes = await admin.graphql(
      `#graphql
      mutation deleteProduct($id: ID!) {
        productDelete(input: { id: $id }) {
          deletedProductId
          userErrors { field message }
        }
      }`,
      { variables: { id: productId } }
    );

    const deleteJson = await deleteRes.json();
    const errors = deleteJson?.data?.productDelete?.userErrors;

    if (errors?.length) {
      return Response.json(
        { error: "Product delete failed", details: errors },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      deletedProductId: deleteJson.data.productDelete.deletedProductId,
    });
  } catch (error) {
    return Response.json(
      { error: "Unexpected server error", details: String(error) },
      { status: 500 }
    );
  }
};

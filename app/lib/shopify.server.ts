// app/models/shopify.server.ts
import { authenticate } from "../shopify.server";

export async function fetchShopifyVariants(request: Request) {
  const { admin } = await authenticate.admin(request);

  const query = `
    query getVariants($cursor: String) {
      products(first: 50, after: $cursor) {
        edges {
          cursor
          node {
            id
            title
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor: string | null = null;
  let variants: any[] = [];

  while (hasNextPage) {
    const res = await admin.graphql(query, { variables: { cursor } });
    const json = await res.json();

    const edges = json.data.products.edges;

    edges.forEach((product: any) => {
      product.node.variants.edges.forEach((v: any) => {
        variants.push(v.node);
      });
    });

    hasNextPage = json.data.products.pageInfo.hasNextPage;
    cursor = edges[edges.length - 1]?.cursor;
  }

  return variants;
}

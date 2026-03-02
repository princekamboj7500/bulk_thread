import fs from "fs";
import path from "path";
import readline from "readline";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { style, productId } = await request.json();

    if (!style || !productId) {
      return Response.json({ error: "Missing style or productId" }, { status: 400 });
    }

    /* STEP 1: Aggregate CSV inventory */
    const fileStream = fs.createReadStream(CACHE_FILE, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const variantMap = new Map<string, number>(); // key = Color||Size -> qty

    for await (const line of rl) {
      if (!line.trim() || line === "[" || line === "]") continue;

      const row = JSON.parse(line.replace(/,$/, ""));
      if (row["STYLE#"] !== style) continue;

      const color = row["COLOR_NAME"] || "Default";
      const size = row["SIZE"] || "OS";
      const key = `${color}||${size}`;
      // const key = `${style}||${colorName}||${sizeName}`;
      const qty = parseInt(row["QTY"] || "0", 10);

      variantMap.set(key, (variantMap.get(key) || 0) + qty);
    }

    /* STEP 2: Fetch Shopify variants + inventory */
    const variantRes = await admin.graphql(
      `#graphql
      query getVariants($id: ID!) {
        product(id: $id) {
          variants(first: 250) {
            edges {
              node {
                id
                selectedOptions { name value }
                inventoryItem { id }
                inventoryQuantity
              }
            }
          }
        }
      }`,
      { variables: { id: productId } }
    );

    const variantJson = await variantRes.json();
    const edges = variantJson?.data?.product?.variants?.edges || [];

    /* STEP 3: Compare + update only mismatched */
    const updates: any[] = [];

    for (const edge of edges) {
      const v = edge.node;

      const color = v.selectedOptions.find((o: any) => o.name === "Color")?.value;
      const size = v.selectedOptions.find((o: any) => o.name === "Size")?.value;

      const key = `${color}||${size}`;
      const expectedQty = variantMap.get(key) || 0;

      if (v.inventoryQuantity !== expectedQty) {
        updates.push({
          inventoryItemId: v.inventoryItem.id,
          quantity: expectedQty,
        });
      }
    }

    if (!updates.length) {
      return Response.json({ success: true, message: "Inventory already up to date" });
    }

    /* STEP 4: Get location */
    const locRes = await admin.graphql(`
      query {
        locations(first: 1) {
          edges { node { id } }
        }
      }
    `);
    const locJson = await locRes.json();
    const locationId = locJson.data.locations.edges[0].node.id;

    /* STEP 5: Activate + set quantities */
    for (const u of updates) {
      await admin.graphql(
        `#graphql
        mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel { id }
          }
        }`,
        { variables: { inventoryItemId: u.inventoryItemId, locationId } }
      );

      await admin.graphql(
        `#graphql
        mutation setInventory($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              name: "available",
              reason: "correction",
              ignoreCompareQuantity: true,
              quantities: [
                {
                  inventoryItemId: u.inventoryItemId,
                  locationId,
                  quantity: u.quantity,
                },
              ],
            },
          },
        }
      );
    }

    return Response.json({
      success: true,
      updatedVariants: updates.length,
    });
  } catch (error) {
    return Response.json(
      { error: "Inventory sync failed", details: String(error) },
      { status: 500 }
    );
  }
};

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {downloadSanmarCSV} from "../app/lib/sanmar.server.js"

// ESM dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");

/* ------------------ Shopify GraphQL Helper ------------------ */
async function shopifyGraphQL(shop, token, query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/* ------------------ Streaming JSON Reader ------------------ */
async function readLargeJsonArray(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const result = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;

    const clean = trimmed.replace(/,$/, "");

    try {
      result.push(JSON.parse(clean));
    } catch {
      // ignore malformed
    }
  }

  return result;
}

/* ------------------ Inventory Sync ------------------ */
async function runForShop(shop, accessToken, jsonData) {
  console.log(`Starting inventory sync for shop:: ${shop}`);

  const locRes = await shopifyGraphQL(
    shop,
    accessToken,
    `
      {
        locations(first: 1) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `,
  );

  const locationId = locRes.locations.edges[0].node.id;
  console.log(`Location: ${locRes.locations.edges[0].node.name}`);

  const productCache = {};

  for (const item of jsonData) {
    const style = item["STYLE#"];
    const inventoryKey = item["INVENTORY_KEY"];
    const qty = parseInt(item["QTY"] || "0");

    if (!style || !inventoryKey) continue;

    if (!productCache[style]) {
      console.log(`Fetching products for style: ${style}`);

      const productRes = await shopifyGraphQL(
        shop,
        accessToken,
        `
          query ($query: String!) {
            products(first: 10, query: $query) {
              edges {
                node {
                  id
                  productType
                  variants(first: 100) {
                    edges {
                      node {
                        id
                        sku
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { query: `product_type:${style}` },
      );

      productCache[style] = productRes.products.edges;
    }

    const products = productCache[style];

    for (const p of products) {
      for (const v of p.node.variants.edges) {
        if (v.node.sku === inventoryKey) {
          console.log(`${shop} → SKU ${inventoryKey} => ${qty}`);

          await shopifyGraphQL(
            shop,
            accessToken,
            `
              mutation inventorySet($input: InventorySetOnHandQuantitiesInput!) {
                inventorySetOnHandQuantities(input: $input) {
                  userErrors {
                    field
                    message
                  }
                }
              }
            `,
            {
              input: {
                setQuantities: [
                  {
                    inventoryItemId: v.node.inventoryItem.id,
                    locationId,
                    quantity: qty,
                  },
                ],
                reason: "correction",
              },
            },
          );
        }
      }
    }
  }

  console.log(`Inventory sync completed for shop: ${shop}`);
}

/* ------------------ Main Runner ------------------ */
async function run() {
  try {
    console.log("Starting full nightly sync...");

    console.log("⬇ Downloading Sanmar CSV...");
    await downloadSanmarCSV({ force: true });

    console.log("Reading cache file...");
    const jsonData = await readLargeJsonArray(CACHE_FILE);
    console.log(`Total rows: ${jsonData.length}`);

    // STEP 2 — Load Prisma
    const prismaModule = await import(
      new URL("./prisma.client.js", import.meta.url).href
    );
    const prisma = prismaModule.default;

    console.log("Fetching offline sessions...");
    const sessions = await prisma.session.findMany({
      where: { isOnline: false },
    });

    if (!sessions.length) {
      console.log("No installed shops found.");
      process.exit(0);
    }

    console.log(`Found ${sessions.length} shop(s)`);

    for (const session of sessions) {
      await runForShop(session.shop, session.accessToken, jsonData);
    }

    console.log("Full nightly sync completed.");
    process.exit(0);
  } catch (err) {
    console.error("Nightly sync failed:", err);
    process.exit(1);
  }
}

run();

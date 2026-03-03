import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root cache file
const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");

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

//  STREAMING JSON READER (memory safe)
async function readLargeJsonArray(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const result = [];

  for await (const line of rl) {
    const trimmed = line.trim();

    // Skip brackets or empty lines
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;

    const clean = trimmed.replace(/,$/, ""); // remove trailing comma

    try {
      result.push(JSON.parse(clean));
    } catch {
      // ignore malformed line
    }
  }

  return result;
}

async function runForShop(shop, accessToken, jsonData) {
  console.log(` Starting inventory sync for shop: ${shop}`);

  // Get location id
  const locRes = await shopifyGraphQL(
    shop,
    accessToken,
    `{
      locations(first:1){
        edges{ node{ id name } }
      }
    }`
  );

  const locationId = locRes.locations.edges[0].node.id;
  console.log(` Location: ${locRes.locations.edges[0].node.name}`);

  const productCache = {};

  for (const item of jsonData) {
    const style = item["STYLE#"];
    const inventoryKey = item["INVENTORY_KEY"];
    const qty = parseInt(item["QTY"] || "0");

    if (!style || !inventoryKey) continue;

    if (!productCache[style]) {
      console.log(` Fetching products for style: ${style}`);

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
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }
        }
        `,
        { query: `product_type:${style}` }
      );

      productCache[style] = productRes.products.edges;
    }

    const products = productCache[style];

    for (const p of products) {
      for (const v of p.node.variants.edges) {
        if (v.node.sku === inventoryKey) {
          console.log(`🛠 ${shop} → SKU ${inventoryKey} => ${qty}`);

          await shopifyGraphQL(
            shop,
            accessToken,
            `
            mutation inventorySet($input: InventorySetOnHandQuantitiesInput!) {
              inventorySetOnHandQuantities(input: $input) {
                userErrors { field message }
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
            }
          );
        }
      }
    }
  }

  console.log(` Inventory sync completed for shop: ${shop}`);
}

async function run() {
  try {
    console.log(" Loading Sanmar cache file (streaming mode)...");

    //  Only changed logic (stream read)
    const jsonData = await readLargeJsonArray(CACHE_FILE);

    console.log(` Total variant rows: ${jsonData.length}`);

    // Dynamically load Prisma client (UNCHANGED)
    const prismaModule = await import(
      new URL("./prisma.client.js", import.meta.url).href
    );
    const prisma = prismaModule.default;

    console.log(" Fetching all offline sessions (installed shops)...");
    const sessions = await prisma.session.findMany({
      where: { isOnline: false },
    });

    if (!sessions.length) {
      console.log(" No installed shops found.");
      return;
    }

    console.log(`Found ${sessions.length} shop(s)`);

    for (const session of sessions) {
      try {
        await runForShop(session.shop, session.accessToken, jsonData);
      } catch (err) {
        console.error(` Failed for shop ${session.shop}:`, err);
      }
    }

    console.log(" All shops inventory sync completed.");
    process.exit(0);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

run();

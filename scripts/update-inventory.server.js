import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import SftpClient from "ssh2-sftp-client";
import unzipper from "unzipper";

/* ---------------- ESM dirname fix ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");
const ZIP_FILE = path.join(process.cwd(), "SanMar_EPDD.zip");

/* ---------------- STYLE EXTRACTOR ---------------- */
function extractStyle(handle) {
  if (!handle) return null;

  const parts = handle.toLowerCase().split("-").filter(Boolean);

  const styles = [];

  for (const part of parts) {
    // must contain digit
    if (!/\d/.test(part)) continue;

    // ignore single numbers like 1,4,5,7
    if (/^\d$/.test(part)) continue;

    // ignore size units like 14l, 10oz
    if (/^\d+(l|ml|oz)$/i.test(part)) continue;

    // valid style patterns
    if (/^[a-z]*\d+[a-z]*$/i.test(part)) {
      styles.push(part);
    }
  }

  if (!styles.length) return null;

  // prefer longest style (112pl over 112)
  styles.sort((a, b) => b.length - a.length);

  return styles[0].toUpperCase();
}

/* ---------------- Shopify GraphQL Helper ---------------- */
async function shopifyGraphQL(shop, token, query, variables = {}, retries = 3) {
  try {
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
  } catch (err) {
    if (retries > 0) {
      console.log("Retrying Shopify call...", retries);
      await new Promise((r) => setTimeout(r, 2000)); // wait 2 sec
      return shopifyGraphQL(shop, token, query, variables, retries - 1);
    }

    console.error("Final failure:", err);
    throw err;
  }
}

/* ---------------- Sanmar CSV Download ---------------- */
async function downloadSanmarCSV() {
  const sftp = new SftpClient();

  console.log("Connecting to SanMar SFTP...");

  await sftp.connect({
    host: process.env.FTP_DOMAIN_SANMAR,
    username: process.env.FTP_USERNAME_SANMAR,
    password: process.env.FTP_PASSWORD_SANMAR,
    port: 2200,
  });

  console.log("Downloading Sanmar file...");

  await sftp.fastGet("/SanMarPDD/SanMar_EPDD_csv.zip", ZIP_FILE);
  await sftp.end();

  console.log("Unzipping CSV...");

  await new Promise((resolve, reject) => {
    fs.createReadStream(ZIP_FILE)
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        const name = entry.path.toLowerCase();
        if (name.endsWith(".csv")) {
          entry.pipe(fs.createWriteStream(CSV_FILE)).on("finish", resolve);
        } else {
          entry.autodrain();
        }
      })
      .on("error", reject);
  });

  console.log("Building JSON cache...");

  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(CSV_FILE);
    const writeStream = fs.createWriteStream(CACHE_FILE);

    writeStream.write("[\n");

    let buffer = [];
    let first = true;

    Papa.parse(readStream, {
      header: true,
      skipEmptyLines: true,
      step: (row) => {
        buffer.push(JSON.stringify(row.data));

        if (buffer.length >= 500) {
          const chunk = (first ? "" : ",\n") + buffer.join(",\n");
          writeStream.write(chunk);
          buffer = [];
          first = false;
        }
      },
      complete: () => {
        if (buffer.length) {
          const chunk = (first ? "" : ",\n") + buffer.join(",\n");
          writeStream.write(chunk);
        }
        writeStream.write("\n]");
        writeStream.end(resolve);
      },
      error: reject,
    });
  });
}

/* ---------------- Build Shopify style-color-size Map ---------------- */
async function buildSkuMap(shop, token) {
  console.log("Scanning Shopify products...");

  const variantMap = {};
  let productCursor = null;
  let hasNextProducts = true;

  while (hasNextProducts) {
    const productData = await shopifyGraphQL(
      shop,
      token,
      `
      query ($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id handle } }
        }
      }
      `,
      { cursor: productCursor },
    );

    const products = productData.products.edges;

    for (const p of products) {
      const productId = p.node.id;
      const handle = p.node.handle;
      const style = extractStyle(handle);
      if (!style) continue;

      let variantCursor = null;
      let hasNextVariants = true;

      while (hasNextVariants) {
        const variantData = await shopifyGraphQL(
          shop,
          token,
          `
          query ($id: ID!, $cursor: String) {
            product(id: $id) {
              variants(first: 250, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    selectedOptions { name value }
                    inventoryItem { id }
                  }
                }
              }
            }
          }
          `,
          { id: productId, cursor: variantCursor },
        );

        const variants = variantData.product.variants.edges;

        for (const v of variants) {
          let color = "Default";
          let size = "OS";

          for (const opt of v.node.selectedOptions) {
            const name = opt.name.toLowerCase();

            if (name.includes("color") || name.includes("colour")) {
              color = opt.value;
            }

            if (name.includes("size")) {
              size = opt.value;
            }
          }

          const key = `${style}-${color}-${size}`.toUpperCase();

          variantMap[key] = v.node.inventoryItem.id;
        }

        hasNextVariants = variantData.product.variants.pageInfo.hasNextPage;
        variantCursor = variantData.product.variants.pageInfo.endCursor;
      }
    }

    hasNextProducts = productData.products.pageInfo.hasNextPage;
    productCursor = productData.products.pageInfo.endCursor;

    console.log("Fetched product batch...");
  }

  console.log("Total variants mapped:", Object.keys(variantMap).length);

  return variantMap;
}

/* ---------------- Stream Sanmar JSON ---------------- */
async function processSanmar(file, callback) {
  const stream = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const clean = line.trim();
    if (!clean || clean === "[" || clean === "]") continue;

    const json = JSON.parse(clean.replace(/,$/, ""));
    await callback(json);
  }
}

/* ---------------- Inventory Update ---------------- */
async function runInventorySync(shop, token, file) {
  console.log("Fetching location...");

  const loc = await shopifyGraphQL(
    shop,
    token,
    `{
      locations(first:1){ edges{ node { id } } }
    }`,
  );

  const locationId = loc.locations.edges[0].node.id;
  console.log("Location:", locationId);

  const variantMap = await buildSkuMap(shop, token);
  let updates = [];
  let referenceDocumentUri ="logistics://some.warehouse/take/2023-01-23T13:14:15Z"
  await processSanmar(file, async (row) => {
    const style = row["STYLE#"];
    const color = row["COLOR_NAME"] || "Default";
    const size = row["SIZE"] || "OS";
    // const qty = parseInt(row["QTY"] || "0");
    const qty = Number(row["QTY"]);
    if (isNaN(qty)) return;
    if (!style) return;

    const key = `${style}-${color}-${size}`.toUpperCase();
    const inventoryItemId = variantMap[key];

    if (!inventoryItemId) return;

    console.log(
      `Updating → Style: ${style}, Color: ${color}, Size: ${size}, Qty: ${qty}`,
    );

    updates.push({ inventoryItemId, locationId, quantity: qty, compareQuantity: 0 });

    if (updates.length >= 50) {
      await pushUpdates(shop, token,referenceDocumentUri, updates);
      updates = [];
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  if (updates.length) await pushUpdates(shop, token, referenceDocumentUri, updates);

  console.log("Inventory sync complete.");
}

/* ---------------- Push Inventory Updates ---------------- */
async function pushUpdates(shop, token,referenceDocumentUri, quantities) {
  console.log("Updating batch:", quantities.length);
  let attempts = 3;

  while (attempts > 0) {
    try {
      const res = await shopifyGraphQL(
        shop,
        token,
        `
        mutation InventorySet($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              createdAt
              reason
              referenceDocumentUri
              changes {
                name
                delta
              }
            }
            userErrors {
              field
              message
            }
          }
        }
        `,
        { input: { name: "available", reason: "correction",referenceDocumentUri:referenceDocumentUri, quantities: quantities } },
      );

      const errors = res.inventorySetQuantities.userErrors;

      if (errors.length) {
        console.error("Shopify userErrors:", errors);
      } else {
        console.log(" Batch success");
      }

      return;
    } catch (err) {
      attempts--;
      console.error(`Batch retry left: ${attempts}`, err);

      if (attempts === 0) {
        console.error(" Final batch failed:", quantities);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* ---------------- Main ---------------- */
async function run() {
  console.log("Starting nightly sync...");

  await downloadSanmarCSV();

  await runInventorySync(
    `${process.env.SHOPIFY_STORE}.myshopify.com`,
    process.env.SHOPIFY_PASSWORD,
    CACHE_FILE,
  );

  console.log("Sync finished.");
}

run();

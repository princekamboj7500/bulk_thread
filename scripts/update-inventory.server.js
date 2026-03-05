// import "dotenv/config";
// import fs from "fs";
// import path from "path";
// import readline from "readline";
// import { fileURLToPath } from "url";
// import Papa from "papaparse";
// import SftpClient from "ssh2-sftp-client";
// import unzipper from "unzipper";

// /* ------------------ ESM dirname fix ------------------ */
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
// const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");
// const ZIP_FILE = path.join(process.cwd(), "SanMar_EPDD.zip");
// const SESSION_FILE = path.join(process.cwd(), "offline-sessions.json");

// async function downloadSanmarCSV(options = {}) {
//   const force = options?.force === true;

//   if (!force && fs.existsSync(CACHE_FILE)) {
//     console.log("Using cached SanMar data...");
//     return true;
//   }

//   if (force) {
//     console.log("Force sync enabled → clearing old cache...");
//     if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
//     if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
//     if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
//   }

//   const sftp = new SftpClient();

//   console.log("Connecting to SanMar SFTP...");

//   await sftp.connect({
//     host: process.env.FTP_DOMAIN_SANMAR,
//     username: process.env.FTP_USERNAME_SANMAR,
//     password: process.env.FTP_PASSWORD_SANMAR,
//     port: 2200,
//     readyTimeout: 60000,
//   });

//   console.log("Downloading EPDD zip...");
//   await sftp.fastGet("/SanMarPDD/SanMar_EPDD_csv.zip", ZIP_FILE);
//   await sftp.end();

//   console.log("Unzipping CSV...");

//   await new Promise((resolve, reject) => {
//     fs.createReadStream(ZIP_FILE)
//       .pipe(unzipper.Parse())
//       .on("entry", (entry) => {
//         const fileName = entry.path.toLowerCase();
//         if (fileName.endsWith(".csv")) {
//           entry
//             .pipe(fs.createWriteStream(CSV_FILE))
//             .on("finish", resolve)
//             .on("error", reject);
//         } else {
//           entry.autodrain();
//         }
//       })
//       .on("error", reject);
//   });

//   if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

//   console.log("Building JSON cache (streamed)...");

//   return new Promise((resolve, reject) => {
//     const fileStream = fs.createReadStream(CSV_FILE);
//     const writeStream = fs.createWriteStream(CACHE_FILE);

//     writeStream.write("[\n");

//     let buffer = [];
//     let count = 0;
//     const BATCH_SIZE = 500;
//     let isFirstRow = true;

//     function flushBuffer() {
//       if (!buffer.length) return;
//       const chunk = (isFirstRow ? "" : ",\n") + buffer.join(",\n");
//       buffer = [];
//       isFirstRow = false;

//       if (!writeStream.write(chunk)) {
//         fileStream.pause();
//         writeStream.once("drain", () => fileStream.resume());
//       }
//     }

//     Papa.parse(fileStream, {
//       header: true,
//       skipEmptyLines: true,
//       step: (result) => {
//         buffer.push(JSON.stringify(result.data));
//         count++;
//         if (buffer.length >= BATCH_SIZE) flushBuffer();
//       },
//       complete: () => {
//         flushBuffer();
//         writeStream.write("\n]");
//         writeStream.end(() => {
//           console.log(`Parsed ${count} rows & cache rebuilt`);
//           resolve(true);
//         });
//       },
//       error: reject,
//     });
//   });
// }

// /* ------------------ Shopify GraphQL Helper ------------------ */
// async function shopifyGraphQL(shop, token, query, variables = {}) {
//   const res = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "X-Shopify-Access-Token": token,
//     },
//     body: JSON.stringify({ query, variables }),
//   });

//   const json = await res.json();
//   if (json.errors) throw new Error(JSON.stringify(json.errors));
//   return json.data;
// }

// /* ------------------ STREAM PROCESSOR ------------------ */
// async function processLargeJsonFile(filePath, callback) {
//   const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
//   const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

//   for await (const line of rl) {
//     const trimmed = line.trim();
//     if (!trimmed || trimmed === "[" || trimmed === "]") continue;

//     const clean = trimmed.replace(/,$/, "");

//     try {
//       const parsed = JSON.parse(clean);
//       await callback(parsed);
//     } catch {}
//   }
// }

// /* ------------------ Inventory Sync ------------------ */
// async function runForShop(shop, accessToken, filePath) {
//   console.log(`Starting inventory sync for shop: ${shop}`);

//   const locRes = await shopifyGraphQL(
//     shop,
//     accessToken,
//     `
//       {
//         locations(first: 1) {
//           edges {
//             node {
//               id
//               name
//             }
//           }
//         }
//       }
//     `
//   );

//   const locationId = locRes.locations.edges[0].node.id;
//   console.log(`Location: ${locRes.locations.edges[0].node.name}`);

//   const productCache = {};

//   await processLargeJsonFile(filePath, async (item) => {
//     const style = item["STYLE#"];
//     const inventoryKey = item["INVENTORY_KEY"];
//     const qty = parseInt(item["QTY"] || "0");

//     if (!style || !inventoryKey) return;

//     if (!productCache[style]) {
//       console.log(`Fetching products for style: ${style}`);

//       const productRes = await shopifyGraphQL(
//         shop,
//         accessToken,
//         `
//           query ($query: String!) {
//             products(first: 10, query: $query) {
//               edges {
//                 node {
//                   id
//                   productType
//                   variants(first: 100) {
//                     edges {
//                       node {
//                         id
//                         sku
//                         inventoryItem {
//                           id
//                         }
//                       }
//                     }
//                   }
//                 }
//               }
//             }
//           }
//         `,
//         { query: `product_type:${style}` }
//       );

//       productCache[style] = productRes.products.edges;
//     }

//     const products = productCache[style];

//     for (const p of products) {
//       for (const v of p.node.variants.edges) {
//         if (v.node.sku === inventoryKey) {
//           console.log(`${shop} → SKU ${inventoryKey} => ${qty}`);

//           await shopifyGraphQL(
//             shop,
//             accessToken,
//             `
//               mutation inventorySet($input: InventorySetOnHandQuantitiesInput!) {
//                 inventorySetOnHandQuantities(input: $input) {
//                   userErrors {
//                     field
//                     message
//                   }
//                 }
//               }
//             `,
//             {
//               input: {
//                 setQuantities: [
//                   {
//                     inventoryItemId: v.node.inventoryItem.id,
//                     locationId,
//                     quantity: qty,
//                   },
//                 ],
//                 reason: "correction",
//               },
//             }
//           );
//         }
//       }
//     }
//   });

//   console.log(`Inventory sync completed for shop: ${shop}`);
// }

// /* ------------------ Main Runner ------------------ */
// async function run() {
//   try {
//     console.log("Starting full nightly sync...");

//     console.log("⬇ Downloading Sanmar CSV...");
//     await downloadSanmarCSV({ force: true });

//     // ✅ READ SESSIONS FROM JSON FILE (Prisma removed)
//     // if (!fs.existsSync(SESSION_FILE)) {
//     //   console.log("No offline session file found.");
//     //   process.exit(0);
//     // }

//     // const sessions = JSON.parse(
//     //   fs.readFileSync(SESSION_FILE, "utf-8")
//     // );

//     // if (!sessions.length) {
//     //   console.log("No installed shops found.");
//     //   process.exit(0);
//     // }

//     // console.log(`Found ${sessions.length} shop(s)`);

//     // for (const session of sessions) {
//     //   await runForShop(session.shop, session.accessToken, CACHE_FILE);
//     // }
//     await runForShop(`${process.env.SHOPIFY_STORE}.myshopify.com`, process.env.SHOPIFY_ACCESS_TOKEN, CACHE_FILE);

//     console.log("Full nightly sync completed.");
//     process.exit(0);
//   } catch (err) {
//     console.error("Nightly sync failed:", err);
//     process.exit(1);
//   }
// }

// run();


import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import SftpClient from "ssh2-sftp-client";
import unzipper from "unzipper";

/* ------------------ ESM dirname fix ------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");
const ZIP_FILE = path.join(process.cwd(), "SanMar_EPDD.zip");

/* ------------------ ENV ------------------ */

const SHOP = `${process.env.SHOPIFY_STORE}.myshopify.com`;
const CLIENT_ID = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;

/* =======================================================
   GET ACCESS TOKEN FROM SHOPIFY
======================================================= */
console.log(SHOP, CLIENT_ID, CLIENT_SECRET, "details_____");
async function getAccessToken(domain) {
  console.log("Requesting Shopify access token...");

  const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const tokenJson = await tokenRes?.json();
  console.log(tokenJson,"tokenJson_______");

  if (!tokenJson?.access_token) {
    throw new Error("Failed to get Shopify access token");
  }

  console.log("Access token received");

  return tokenJson.access_token;
}

/* =======================================================
   DOWNLOAD SANMAR CSV (UNCHANGED)
======================================================= */

async function downloadSanmarCSV(options = {}) {
  const force = options?.force === true;

  if (!force && fs.existsSync(CACHE_FILE)) {
    console.log("Using cached SanMar data...");
    return true;
  }

  if (force) {
    console.log("Force sync enabled → clearing old cache...");
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
    if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
  }

  const sftp = new SftpClient();

  console.log("Connecting to SanMar SFTP...");

  await sftp.connect({
    host: process.env.FTP_DOMAIN_SANMAR,
    username: process.env.FTP_USERNAME_SANMAR,
    password: process.env.FTP_PASSWORD_SANMAR,
    port: 2200,
    readyTimeout: 60000,
  });

  console.log("Downloading EPDD zip...");
  await sftp.fastGet("/SanMarPDD/SanMar_EPDD_csv.zip", ZIP_FILE);
  await sftp.end();

  console.log("Unzipping CSV...");

  await new Promise((resolve, reject) => {
    fs.createReadStream(ZIP_FILE)
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        const fileName = entry.path.toLowerCase();
        if (fileName.endsWith(".csv")) {
          entry
            .pipe(fs.createWriteStream(CSV_FILE))
            .on("finish", resolve)
            .on("error", reject);
        } else {
          entry.autodrain();
        }
      })
      .on("error", reject);
  });

  if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

  console.log("Building JSON cache (streamed)...");

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(CSV_FILE);
    const writeStream = fs.createWriteStream(CACHE_FILE);

    writeStream.write("[\n");

    let buffer = [];
    let count = 0;
    const BATCH_SIZE = 500;
    let isFirstRow = true;

    function flushBuffer() {
      if (!buffer.length) return;
      const chunk = (isFirstRow ? "" : ",\n") + buffer.join(",\n");
      buffer = [];
      isFirstRow = false;

      if (!writeStream.write(chunk)) {
        fileStream.pause();
        writeStream.once("drain", () => fileStream.resume());
      }
    }

    Papa.parse(fileStream, {
      header: true,
      skipEmptyLines: true,
      step: (result) => {
        buffer.push(JSON.stringify(result.data));
        count++;
        if (buffer.length >= BATCH_SIZE) flushBuffer();
      },
      complete: () => {
        flushBuffer();
        writeStream.write("\n]");
        writeStream.end(() => {
          console.log(`Parsed ${count} rows & cache rebuilt`);
          resolve(true);
        });
      },
      error: reject,
    });
  });
}

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

/* ------------------ STREAM PROCESSOR ------------------ */

async function processLargeJsonFile(filePath, callback) {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;

    const clean = trimmed.replace(/,$/, "");

    try {
      const parsed = JSON.parse(clean);
      await callback(parsed);
    } catch {}
  }
}

/* ------------------ Inventory Sync ------------------ */

async function runForShop(shop, accessToken, filePath) {
  console.log(`Starting inventory sync for shop: ${shop}`);

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
  `
  );

  const locationId = locRes.locations.edges[0].node.id;

  const productCache = {};

  await processLargeJsonFile(filePath, async (item) => {
    const style = item["STYLE#"];
    const inventoryKey = item["INVENTORY_KEY"];
    const qty = parseInt(item["QTY"] || "0");

    if (!style || !inventoryKey) return;

    if (!productCache[style]) {
      const productRes = await shopifyGraphQL(
        shop,
        accessToken,
        `
        query ($query: String!) {
          products(first: 10, query: $query) {
            edges {
              node {
                variants(first: 100) {
                  edges {
                    node {
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
          console.log(`${shop} → SKU ${inventoryKey} => ${qty}`);

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
  });

  console.log(`Inventory sync completed`);
}

/* ------------------ Main Runner ------------------ */

async function run() {
  try {
    console.log("Starting nightly sync...");

    const accessToken = await getAccessToken(SHOP);

    console.log("Downloading Sanmar CSV...");
    await downloadSanmarCSV({ force: true });

    await runForShop(SHOP, accessToken, CACHE_FILE);

    console.log("Nightly sync completed");
    process.exit(0);
  } catch (err) {
    console.error("Nightly sync failed:", err);
    process.exit(1);
  }
}

run();

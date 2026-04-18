import fs from "fs";
import path from "path";
import readline from "readline";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import he from "he";
const STATUS_FILE = path.join(process.cwd(), "product-status.json");
const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const PAGE_SIZE = 50;

/* ---------------- MEMORY CACHE ---------------- */

let sanmarCache: any[] | null = null;
let cacheLoaded = false;
/* ---------------- STYLE EXTRACTOR ---------------- */
function readStatusFile() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}
function extractStyleFromHandle(handle: string | null) {
  if (!handle) return null;

  const parts = handle.toLowerCase().split("-").filter(Boolean);

  const styles = [];

  for (const part of parts) {
    if (!/\d/.test(part)) continue;

    if (/^\d$/.test(part)) continue;
    if (/^\d+(l|ml|oz)$/i.test(part)) continue;
    if (/^[a-z]*\d+[a-z]*$/i.test(part)) {
      styles.push(part);
    }
  }
  if (!styles.length) return null;
  styles.sort((a, b) => b.length - a.length);

  return styles[0].toUpperCase();
}

/* ---------------- LOAD SANMAR CACHE (ONLY ONCE) ---------------- */

async function loadSanmarCache() {
  if (sanmarCache && cacheLoaded) return sanmarCache;

  if (!fs.existsSync(CACHE_FILE)) {
    console.error(" CACHE FILE NOT FOUND:", CACHE_FILE);
    sanmarCache = [];
    cacheLoaded = true;
    return sanmarCache;
  }

  console.log(" Loading cache from file...");

  const fileStream = fs.createReadStream(CACHE_FILE, { encoding: "utf8" });

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const map = new Map<string, any>();

  for await (const line of rl) {
    if (!line.trim() || line === "[" || line === "]") continue;

    try {
      const clean = line.replace(/,$/, "");
      const row = JSON.parse(clean);

      const style = row["STYLE#"];
      if (!style) continue;

      const title = he.decode(row["PRODUCT_TITLE"] || "");

      if (!map.has(style)) {
        map.set(style, {
          style,
          title,
          category: row["CATEGORY_NAME"],
          totalVariants: 0,
          totalInventory: 0,
          seenVariants: new Set(),
          image:
            row["FRONT_MODEL_IMAGE_URL"] ||
            (row["PRODUCT_IMAGE"]
              ? `https://cdnm.sanmar.com/imglib/mresjpg/${row["PRODUCT_IMAGE"]}`
              : null),
        });
      }

      const product = map.get(style);

      const color = row["COLOR_NAME"] || "Default";
      const size = row["SIZE"] || "OS";

      const variantKey = `${color}-${size}`;
      const qty = parseInt(row["QTY"] || "0", 10);

      if (!product.seenVariants.has(variantKey)) {
        product.seenVariants.add(variantKey);
        product.totalVariants += 1;
        product.totalInventory += qty;
      }
    } catch (err) {
      console.error(" JSON PARSE ERROR:", err);
    }
  }

  sanmarCache = Array.from(map.values()).map((p) => {
    delete p.seenVariants;
    return p;
  });

  cacheLoaded = true;

  console.log(" Cache loaded:", sanmarCache.length);

  return sanmarCache;
}

/* ---------------- LOADER ---------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {

  const { admin } = await authenticate.admin(request);
  console.log("CACHE FILE PATH:", CACHE_FILE);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const search = (url.searchParams.get("search") || "").toLowerCase();
  const filter = url.searchParams.get("filter") || "all";
  const statusMap = readStatusFile();
  /* Sanmar cache load */
  const grouped = await loadSanmarCache();

  /* ---------------- FETCH SHOPIFY PRODUCTS ---------------- */

  const typeToIdMap: Record<string, string[]> = {};
  const typeToSyncMap: Record<string, string[]> = {};

  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const res = await admin.graphql(
      `#graphql
      query getProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              handle
              metafield(namespace: "custom", key: "sync_status") {
                value
              }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const json = await res.json();

    const products = json?.data?.products?.edges || [];

    for (const edge of products) {
      const handle = edge.node.handle;
      const style = extractStyleFromHandle(handle);

      if (style) {
        if (!typeToIdMap[style]) {
          typeToIdMap[style] = [];
        }

        typeToIdMap[style].push(edge.node.id);
        if (!typeToSyncMap[style]) {
          typeToSyncMap[style] = [];
        }
        typeToSyncMap[style].push(edge.node.metafield?.value || null);
      }
    }

    hasNextPage = json?.data?.products?.pageInfo?.hasNextPage;
    cursor = json?.data?.products?.pageInfo?.endCursor;
  }

  /* ---------------- SEARCH ---------------- */

  let filtered = grouped;

  if (search) {
    filtered = filtered.filter((p) => {
      const title = (p.title || "").toLowerCase();
      const style = String(p.style || "").toLowerCase();
      const category = (p.category || "").toLowerCase();

      return (
        title.includes(search) ||
        style.includes(search) ||
        category.includes(search)
      );
    });
  }

  /* ---------------- MAP SANMAR PRODUCTS ---------------- */

  // let finalProducts = filtered.map((p) => {
  //   const productIds = typeToIdMap[String(p.style).toUpperCase()] || [];

  //   return {
  //     ...p,
  //     existsInStore: productIds.length > 0,
  //     productIds,
  //   };
  // });
  let finalProducts = filtered.map((p) => {
    const styleKey = String(p.style).toUpperCase();
    const productIds = typeToIdMap[styleKey] || [];
    const syncValues = typeToSyncMap[styleKey] || [];

    return {
      ...p,
      existsInStore: productIds.length > 0,
      productIds,
      isProcessing: statusMap[styleKey] === true,
      sync_status: syncValues.some(v => v !== "false"),
    };
  });

  /* ---------------- FILTER ---------------- */

  if (filter === "added") {
    finalProducts = finalProducts.filter((p) => p.existsInStore);
  }

  if (filter === "not_added") {
    finalProducts = finalProducts.filter((p) => !p.existsInStore);
  }

  /* ---------------- PAGINATION ---------------- */

  const totalPages = Math.ceil(finalProducts.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;

  const paginated = finalProducts.slice(start, start + PAGE_SIZE);

  return Response.json({
    products: paginated,
    page,
    totalPages,
  });
};

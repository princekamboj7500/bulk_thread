import fs from "fs";
import path from "path";
import readline from "readline";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import he from "he";
import prisma from "app/db.server";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const PAGE_SIZE = 50;

/* ---------------- STYLE EXTRACTOR (Handle Based) ---------------- */

function extractStyleFromHandle(handle: string | null) {
  if (!handle) return null;

  const parts = handle.toLowerCase().split("-").filter(Boolean);

  const candidates = [];

  for (const part of parts) {
    // must contain digit
    if (!/\d/.test(part)) continue;

    // ignore small numeric tokens
    if (/^\d$/.test(part)) continue;

    // ignore patterns like 1-4 or 5-in-1 pieces already split
    if (part === "in") continue;

    // strong candidates (letters+numbers)
    if (/^[a-z]*\d+[a-z]*$/i.test(part)) {
      candidates.push(part);
    }
  }

  if (!candidates.length) return null;

  return candidates[candidates.length - 1];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const search = (url.searchParams.get("search") || "").toLowerCase();
  const filter = url.searchParams.get("filter") || "all";

  if (!fs.existsSync(CACHE_FILE)) {
    return Response.json({ products: [], page: 1, totalPages: 1 });
  }

  const fileStream = fs.createReadStream(CACHE_FILE, { encoding: "utf8" });

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const map = new Map<string, any>();

  for await (const line of rl) {
    if (!line.trim() || line === "[" || line === "]") continue;

    const clean = line.replace(/,$/, "");
    const row = JSON.parse(clean);

    const style = row["STYLE#"];
    if (!style) continue;

    const title = he.decode(row["PRODUCT_TITLE"] || "");
    const styleStr = String(style).toLowerCase();
    const category = (row["CATEGORY_NAME"] || "").toLowerCase();

    if (
      search &&
      !title.toLowerCase().includes(search) &&
      !styleStr.includes(search) &&
      !category.includes(search)
    ) {
      continue;
    }

    /* ---------------- CREATE PRODUCT GROUP ---------------- */

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

    /* ---------------- VARIANT KEY (COLOR + SIZE BASED) ---------------- */

    const color = row["COLOR_NAME"] || "Default";
    const size = row["SIZE"] || "OS";

    const variantKey = `${color}-${size}`;

    const qty = parseInt(row["QTY"] || "0", 10);

    /* ---------------- DUPLICATE CHECK ---------------- */

    if (!product.seenVariants.has(variantKey)) {
      product.seenVariants.add(variantKey);

      product.totalVariants += 1;
      product.totalInventory += qty;
    }
  }

  /* remove helper set before response */

  const grouped = Array.from(map.values()).map((p) => {
    delete p.seenVariants;
    return p;
  });

  /* ---------------- FETCH SHOPIFY PRODUCTS ---------------- */

  let typeToIdMap: Record<string, string[]> = {};

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
            }
          }
        }
      }`,
      {
        variables: { cursor },
      }
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
      }
    }

    hasNextPage = json?.data?.products?.pageInfo?.hasNextPage;
    cursor = json?.data?.products?.pageInfo?.endCursor;
  }

  /* ---------------- MAP SANMAR PRODUCTS ---------------- */

  let finalProducts = grouped.map((p) => {
    const productIds = typeToIdMap[String(p.style).toUpperCase()] || [];

    return {
      ...p,
      existsInStore: productIds.length > 0,
      productIds,
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

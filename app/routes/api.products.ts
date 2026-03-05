import fs from "fs";
import path from "path";
import readline from "readline";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import he from "he";
import prisma from "app/db.server";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const PAGE_SIZE = 50;

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

    // SEARCH FILTER
    if (
      search &&
      !title.toLowerCase().includes(search) &&
      !styleStr.includes(search) &&
      !category.includes(search)
    ) {
      continue;
    }

    if (!map.has(style)) {
      map.set(style, {
        style,
        title,
        category: row["CATEGORY_NAME"],
        totalVariants: 0,
        totalInventory: 0,
        image:
          row["FRONT_MODEL_IMAGE_URL"] ||
          (row["PRODUCT_IMAGE"]
            ? `https://cdnm.sanmar.com/imglib/mresjpg/${row["PRODUCT_IMAGE"]}`
            : null),
      });
    }

    const product = map.get(style);
    product.totalVariants += 1;
    product.totalInventory += parseInt(row["QTY"] || "0", 10);
  }

  const grouped = Array.from(map.values());

  // SHOPIFY MATCH FOR ALL GROUPED STYLES
  const styles = grouped.map((p) => String(p.style));
  const searchQuery = styles.map((s) => `product_type:${s}`).join(" OR ");

  let typeToIdMap: Record<string, string> = {};

  if (searchQuery) {
    const res = await admin.graphql(
      `#graphql
      query getProducts($query: String!) {
        products(first: 250, query: $query) {
          edges {
            node {
              id
              productType
            }
          }
        }
      }`,
      {
        variables: { query: searchQuery },
      }
    );

    const json = await res.json();
    const edges = json?.data?.products?.edges || [];

    typeToIdMap = edges.reduce((acc: any, edge: any) => {
      acc[edge.node.productType] = edge.node.id;
      return acc;
    }, {});
  }

  // MAP WITH SHOPIFY STATUS
  let finalProducts = grouped.map((p) => {
    const productId = typeToIdMap[String(p.style)] || null;

    return {
      ...p,
      existsInStore: Boolean(productId),
      productId,
    };
  });

  // FILTER APPLY
  if (filter === "added") {
    finalProducts = finalProducts.filter((p) => p.existsInStore);
  }

  if (filter === "not_added") {
    finalProducts = finalProducts.filter((p) => !p.existsInStore);
  }

  // PAGINATION LAST
  const totalPages = Math.ceil(finalProducts.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const paginated = finalProducts.slice(start, start + PAGE_SIZE);

  return Response.json({
    products: paginated,
    page,
    totalPages,
  });
};

import fs from "fs";
import path from "path";
import readline from "readline";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);

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

    if (!map.has(style)) {
      map.set(style, {
        style,
        title: row["PRODUCT_TITLE"],
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

  const totalPages = Math.ceil(grouped.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const paginated = grouped.slice(start, start + PAGE_SIZE);

  // Build handle query
  // const handles = paginated.map((p) => `sanmar-${p.style}`);
  const handles = paginated.map((p) => `sanmar-${String(p.style).toLowerCase()}`);
  const searchQuery = handles.map((h) => `handle:${h}`).join(" OR ");

  let handleToIdMap: Record<string, string> = {};

  if (searchQuery) {
    const res = await admin.graphql(
      `#graphql
      query getProducts($query: String!) {
        products(first: 250, query: $query) {
          edges {
            node {
              id
              handle
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
    handleToIdMap = edges.reduce((acc: any, edge: any) => {
      acc[edge.node.handle] = edge.node.id;
      return acc;
    }, {});
  }

  const finalProducts = paginated.map((p) => {
    // const handle = `sanmar-${p.style}`;
    const handle = `sanmar-${String(p.style).toLowerCase()}`;
    const productId = handleToIdMap[handle] || null;

    return {
      ...p,
      existsInStore: Boolean(productId),
      productId,
    };
  });

  return Response.json({
    products: finalProducts,
    page,
    totalPages,
  });
};

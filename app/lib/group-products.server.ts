export function groupProductsByStyle(rows: any[]) {
  const map = new Map();

  for (const row of rows) {
    const style = row["STYLE#"];

    if (!style) continue;

    if (!map.has(style)) {
      map.set(style, {
        style,
        title: row["PRODUCT_TITLE"],
        category: row["CATEGORY_NAME"],
        subcategory: row["SUBCATEGORY_NAME"],
        productImage: row["PRODUCT_IMAGE"],
        totalVariants: 0,
        totalInventory: 0,
        variants: [],
      });
    }

    const product = map.get(style);

    product.totalVariants += 1;
    product.totalInventory += Number(row["QTY"] || 0);

    product.variants.push({
      color: row["COLOR_NAME"],
      size: row["SIZE"],
      qty: Number(row["QTY"] || 0),
      sku: `${row["STYLE#"]}-${row["COLOR_NAME"]}-${row["SIZE"]}`.toLowerCase(),
    });
  }

  return Array.from(map.values());
}

export function compareVariants(sanmar: any[], shopify: any[]) {
  const shopifySkus = new Set(shopify.map((v) => v.sku?.toLowerCase()));

  return sanmar.map((row) => {
    const style = (row["STYLE#"] || "").toLowerCase().trim();
    const color = (row["COLOR_NAME"] || "").toLowerCase().trim();
    const size = (row["SIZE"] || "").toLowerCase().trim();

    const sku = `${style}-${color}-${size}`;

    return {
      sku,
      style,
      color,
      size,
      inventory: row["QTY"] || 0,
      exists: shopifySkus.has(sku),
    };
  });
}

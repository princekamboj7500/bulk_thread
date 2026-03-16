import fs from "fs";
import path from "path";
import readline from "readline";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import he from "he";
const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
function generateHandle(title: string, style: string) {
  const cleanTitle = title
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

  const styleSlug = String(style).toLowerCase();

  // ensure style always at end
  if (!cleanTitle.endsWith(styleSlug)) {
    return `${cleanTitle}-${styleSlug}`;
  }

  return cleanTitle;
}
function getSizeIndex(size: string) {
  const s = size.toUpperCase().trim();

  if (s === "XS") return 0;
  if (s === "S") return 1;
  if (s === "M") return 2;
  if (s === "L") return 3;
  if (s === "XL") return 4;

  const match = s.match(/^(\d+)XL$/);

  if (match) {
    return 4 + parseInt(match[1]);
  }

  return 999;
}
function chunkVariants(arr: any[], size: number) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { style } = await request.json();

    if (!style) {
      return Response.json({ error: "Missing style" }, { status: 400 });
    }

    /* STEP 0: LOCATION */
    // const locRes = await admin.graphql(`
    //   query {
    //     locations(first: 1) {
    //       edges { node { id } }
    //     }
    //   }
    // `);

    // const locJson = await locRes.json();
    // const locationId = locJson?.data?.locations?.edges?.[0]?.node?.id;
    const locRes = await admin.graphql(`
      query {
        locations(first: 50) {
          edges { node { id } }
        }
      }
    `);

    const locJson = await locRes.json();
    const locationIds =
      locJson?.data?.locations?.edges?.map((e: any) => e.node.id) || [];

    if (!locationIds.length) {
      return Response.json({ error: "Failed to fetch shop locations" }, { status: 500 });
    }

    /* keep first location for variant creation structure (unchanged logic) */
    const locationId = locationIds[0];
    if (!locationId) {
      return Response.json({ error: "Failed to fetch shop location" }, { status: 500 });
    }

    /* STEP 1: READ CACHE */
    const fileStream = fs.createReadStream(CACHE_FILE, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let baseProduct: any = null;
    const variantMap = new Map<string, any>();
    const colorImageMap = new Map<string, string>();
    const colorSet = new Set<string>();
    const sizeSet = new Set<string>();
    let rowCount = 0;
    let styleCount = 0;
    for await (const line of rl) {
      rowCount++;
      if (!line.trim() || line === "[" || line === "]") continue;

      const row = JSON.parse(line.replace(/,$/, ""));
      if (row["STYLE#"] !== style) continue;
      if (row["STYLE#"] === style) {
        styleCount++;
      }
      if (!baseProduct) baseProduct = row;

      const colorName = row["COLOR_NAME"] || "Default";
      const sizeName = row["SIZE"] || "OS";
      const key = `${sizeName}||${colorName}`;
      const qty = parseInt(row["QTY"] || "0", 10);
      const imageUrl = row["FRONT_MODEL_IMAGE_URL"] || null;

      colorSet.add(colorName);
      sizeSet.add(sizeName);

      if (variantMap.has(key)) {
        variantMap.get(key).inventoryQuantities[0].availableQuantity = qty;
      } else {
        variantMap.set(key, {
          price: row["MAP_PRICING"] || "0",
          optionValues: [
            { name: sizeName, optionName: "Size" },
            { name: colorName, optionName: "Color" },
          ],
          inventoryItem: { sku: row["INVENTORY_KEY"], tracked: true },
          inventoryQuantities: [{ locationId, availableQuantity: qty }],
          imageUrl, // store per variant
        });
      }

      if (imageUrl && !colorImageMap.has(colorName)) {
        colorImageMap.set(colorName, imageUrl);
      }
    }
    console.log("TOTAL CSV ROWS:", rowCount);
    console.log("ROWS MATCHING STYLE:", styleCount);
    if (!baseProduct) {
      return Response.json({ error: "Product not found" }, { status: 404 });
    }

    // const variants = Array.from(variantMap.values());
    const variants = Array.from(variantMap.values()).sort((a, b) => {
      // const colorA = a.optionValues[0].name;
      // const colorB = b.optionValues[0].name;

      // const sizeA = a.optionValues[1].name;
      // const sizeB = b.optionValues[1].name;
      const sizeA = a.optionValues[0].name;
      const sizeB = b.optionValues[0].name;

      const colorA = a.optionValues[1].name;
      const colorB = b.optionValues[1].name;
      // if (colorA === colorB) {
      //   return getSizeIndex(sizeA) - getSizeIndex(sizeB);
      // }

      // return colorA.localeCompare(colorB);
      if (sizeA === sizeB) {
        return colorA.localeCompare(colorB);
      }

      return getSizeIndex(sizeA) - getSizeIndex(sizeB);
    });
    const MAX_VARIANTS = 250;

    const variantGroups: any[] = [];
    let currentGroup: any[] = [];

    const variantsByColor = new Map<string, any[]>();

    for (const v of variants) {
      const color = v.optionValues[1].name;

      if (!variantsByColor.has(color)) {
        variantsByColor.set(color, []);
      }

      variantsByColor.get(color)!.push(v);
    }

    for (const [, colorVariants] of variantsByColor) {

      if (currentGroup.length + colorVariants.length > MAX_VARIANTS) {
        variantGroups.push(currentGroup);
        currentGroup = [];
      }

      currentGroup.push(...colorVariants);
    }

    if (currentGroup.length) {
      variantGroups.push(currentGroup);
    }
    /* STEP 1.5: FETCH TAXONOMY CATEGORY ID (ROBUST MATCHING) */
    let categoryId: string | null = null;

    const categoryName = baseProduct["CATEGORY_NAME"] || "";
    const subCategoryName = baseProduct["SUBCATEGORY_NAME"] || "";

    async function searchTaxonomy(term: string) {
      if (!term) return [];

      const res = await admin.graphql(
        `#graphql
    query SearchTaxonomyCategories($search: String!) {
      taxonomy {
        categories(search: $search, first: 10) {
          nodes {
            id
            fullName
            isLeaf
          }
        }
      }
    }`,
        { variables: { search: term.toLowerCase() } }
      );

      const json = await res.json();
      return json?.data?.taxonomy?.categories?.nodes || [];
    }

    /* Try: "bags duffels" */
    let nodes = await searchTaxonomy(`${categoryName} ${subCategoryName}`.trim());

    /* Fallback: "duffels" */
    if (!nodes.length && subCategoryName) {
      nodes = await searchTaxonomy(subCategoryName);
    }

    /* Fallback: "bags" */
    if (!nodes.length && categoryName) {
      nodes = await searchTaxonomy(categoryName);
    }

    /* Pick best match */
    const leafNode = nodes.find((n: any) => n.isLeaf);
    const selectedNode = leafNode || nodes[0];

    categoryId = selectedNode?.id || null;
    // const title = he.decode(baseProduct["PRODUCT_TITLE"] || "");
    // const handle = generateHandle(title, style);
    console.log("Taxonomy Search:", `${categoryName} ${subCategoryName}`);
    console.log("Matched Category:", selectedNode?.fullName);
    console.log("Category ID:", categoryId);
    let productIndex = 0;
    const createdProducts: string[] = [];
    const baseTitle = he.decode(baseProduct["PRODUCT_TITLE"] || "");
    const baseHandle = generateHandle(baseTitle, style);
    // const imageArray = Array.from(colorImageMap.values());

    for (const groupVariants of variantGroups) {

      // const groupColorSet = new Set<string>();
      // const groupSizeSet = new Set<string>();

      // groupVariants.forEach((v) => {
      //   groupColorSet.add(v.optionValues[0].name);
      //   groupSizeSet.add(v.optionValues[1].name);
      // });

      // const groupColors = [
      //   ...new Set(groupVariants.map(v => v.optionValues[0].name))
      // ];

      // const groupSizes = [
      //   ...new Set(groupVariants.map(v => v.optionValues[1].name))
      // ].sort((a, b) => getSizeIndex(a) - getSizeIndex(b));
      const imageArray = [
        ...new Set(
          groupVariants
            .map(v => v.imageUrl)
            .filter(Boolean)
        )
      ];
      const groupSizes = [
        ...new Set(groupVariants.map(v => v.optionValues[0].name))
      ].sort((a, b) => getSizeIndex(a) - getSizeIndex(b));

      const groupColors = [
        ...new Set(groupVariants.map(v => v.optionValues[1].name))
      ];
      const title = baseTitle;
      const handle =
        productIndex === 0
          ? baseHandle
          : `${baseHandle}-basic-colors-${productIndex + 1}`;
      /* STEP 2: CREATE PRODUCT */
      const productRes = await admin.graphql(
        `#graphql
      mutation createProduct($input: ProductCreateInput!) {
        productCreate(product: $input) {
          product { id variants(first:250){edges{node{id sku}}} }
          userErrors { field message }
        }
      }`,
        {
          variables: {
            input: {
              title,
              handle,
              vendor: baseProduct["MILL"],
              category: categoryId,
              productType: style,
              descriptionHtml: he.decode(baseProduct["PRODUCT_DESCRIPTION"] || ""),
              tags: [style],
              metafields: [
                {
                  namespace: "custom",
                  key: "subcategory",
                  type: "single_line_text_field",
                  value: baseProduct["SUBCATEGORY_NAME"] || "",
                },
              ],
              // productOptions: [
              //   { name: "Color", values: groupColors.map(n => ({ name: n })) },
              //   { name: "Size", values: groupSizes.map(n => ({ name: n })) },
              // ],
              productOptions: [
                { name: "Size", values: groupSizes.map(n => ({ name: n })) },
                { name: "Color", values: groupColors.map(n => ({ name: n })) },
              ],
            },
          },
        }
      );

      const productJson = await productRes.json();
      const createErrors = productJson?.data?.productCreate?.userErrors;
      if (createErrors?.length) {
        return Response.json({ error: "Product create failed", details: createErrors }, { status: 500 });
      }

      const productId = productJson.data.productCreate.product.id;
      const firstVariantId =
        productJson.data.productCreate.product.variants.edges[0].node.id;

      /* STEP 3: UPDATE FIRST VARIANT (UNCHANGED) */
      const firstVariant = groupVariants[0];
      await admin.graphql(
        `#graphql
      mutation updateFirstVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
        {
          variables: {
            productId,
            variants: [
              {
                id: firstVariantId,
                price: firstVariant.price,
                optionValues: firstVariant.optionValues,
                inventoryItem: firstVariant.inventoryItem,
              },
            ],
          },
        }
      );

      // /* STEP 3.1: INVENTORY (UNCHANGED) */
      // const invRes = await admin.graphql(
      //   `#graphql
      //   query getInventoryItem($id: ID!) {
      //     node(id: $id) {
      //       ... on ProductVariant {
      //         inventoryItem { id }
      //       }
      //     }
      //   }`,
      //   { variables: { id: firstVariantId } }
      // );

      // const invJson = await invRes.json();
      // const inventoryItemId = invJson?.data?.node?.inventoryItem?.id;
      // const qty = variants[0].inventoryQuantities[0].availableQuantity;

      // await admin.graphql(
      //   `#graphql
      //   mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
      //     inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      //       inventoryLevel { id }
      //       userErrors { field message }
      //     }
      //   }`,
      //   { variables: { inventoryItemId, locationId } }
      // );

      // await admin.graphql(
      //   `#graphql
      //   mutation setInventory($input: InventorySetQuantitiesInput!) {
      //     inventorySetQuantities(input: $input) {
      //       userErrors { field message }
      //     }
      //   }`,
      //   {
      //     variables: {
      //       input: {
      //         name: "available",
      //         reason: "correction",
      //         ignoreCompareQuantity: true,
      //         quantities: [
      //           { inventoryItemId, locationId, quantity: qty },
      //         ],
      //       },
      //     },
      //   }
      // );
      /* STEP 3.1: INVENTORY FOR ALL LOCATIONS */
      const invRes = await admin.graphql(
        `#graphql
        query getInventoryItem($id: ID!) {
          node(id: $id) {
            ... on ProductVariant {
              inventoryItem { id }
            }
          }
        }
      `,
        { variables: { id: firstVariantId } }
      );

      const invJson = await invRes.json();
      const inventoryItemId = invJson?.data?.node?.inventoryItem?.id;
      const qty = groupVariants[0].inventoryQuantities[0].availableQuantity;
      console.log(qty, "dsfsfsfasfasf");
      console.log(locationIds, "locationsIds_________");

      /* Loop all locations */
      // for (const locId of locationIds) {
      //   await admin.graphql(
      //     `#graphql
      //       mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
      //         inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      //           inventoryLevel { id }
      //           userErrors { field message }
      //         }
      //       }
      //     `,
      //     { variables: { inventoryItemId, locationId: locId } }
      //   );

      //   await admin.graphql(
      //     `#graphql
      //       mutation setInventory($input: InventorySetQuantitiesInput!) {
      //         inventorySetQuantities(input: $input) {
      //           userErrors { field message }
      //         }
      //       }
      //     `,
      //     {
      //       variables: {
      //         input: {
      //           name: "available",
      //           reason: "correction",
      //           ignoreCompareQuantity: true,
      //           quantities: [
      //             {
      //               inventoryItemId,
      //               locationId: locId,
      //               quantity: qty,
      //             },
      //           ],
      //         },
      //       },
      //     }
      //   );
      // }
      /* one location */
      await admin.graphql(
        `#graphql
        mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel { id }
            userErrors { field message }
          }
        }
      `,
        { variables: { inventoryItemId, locationId } }
      );

      // set inventory only once
      await admin.graphql(
        `#graphql
        mutation setInventory($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            userErrors { field message }
          }
        }
      `,
        {
          variables: {
            input: {
              name: "available",
              reason: "correction",
              ignoreCompareQuantity: true,
              quantities: [
                {
                  inventoryItemId,
                  locationId,
                  quantity: qty,
                },
              ],
            },
          },
        }
      );
      /* STEP 4: CREATE REMAINING VARIANTS */
      const remainingVariants = groupVariants.slice(1);
      const shopifyVariants = remainingVariants.map(({ imageUrl, ...rest }) => rest);
      // console.log(shopifyVariants, "shopVariants___________");
      // shopifyVariants?.forEach((item) => {
      //   console.log(item?.inventoryQuantities, "inventory_quantitiessss_____");
      // });
      if (shopifyVariants.length) {
        await admin.graphql(
          `#graphql
        mutation createVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id sku }
            userErrors { field message }
          }
        }`,
          { variables: { productId, variants: shopifyVariants } }
        );
      }

      /* STEP 5: UPLOAD IMAGES */


      let uploadedMediaIds: string[] = [];
      const imageUrlToMediaId = new Map<string, string>();

      if (imageArray.length) {

        const mediaRes = await admin.graphql(
          `#graphql
          mutation addMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
            productUpdate(product: $product, media: $media) {
              product {
                media(first: 100) {
                  edges {
                    node {
                      ... on MediaImage {
                        id
                      }
                    }
                  }
                }
              }
              userErrors { field message }
            }
          }
        `,
          {
            variables: {
              product: { id: productId },
              media: imageArray.map((url) => ({
                mediaContentType: "IMAGE",
                originalSource: url,
              })),
            },
          }
        );

        const mediaJson = await mediaRes.json();
        const edges = mediaJson?.data?.productUpdate?.product?.media?.edges || [];

        uploadedMediaIds = edges.map((e: any) => e.node.id);

        /* CREATE URL → MEDIA MAP */
        uploadedMediaIds.forEach((mediaId, index) => {
          const url = imageArray[index];
          imageUrlToMediaId.set(url, mediaId);
        });

      }

      /* STEP 6: ASSIGN IMAGES TO VARIANTS (INDEX BASED MAPPING) */
      const variantAssignments: any[] = [];

      // fetch all variants
      let shopify_variants: any[] = [];
      let hasNextPage = true;
      let cursor: string | null = null;

      while (hasNextPage) {

        const variantsRes = await admin.graphql(
          `#graphql
    query getVariants($id: ID!, $cursor: String) {
      product(id: $id) {
        variants(first: 250, after: $cursor) {
          edges {
            cursor
            node {
              id
              selectedOptions {
                name
                value
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    }
    `,
          { variables: { id: productId, cursor } }
        );

        const variantsJson = await variantsRes.json();

        const edges = variantsJson?.data?.product?.variants?.edges || [];

        shopify_variants.push(...edges);

        hasNextPage =
          variantsJson?.data?.product?.variants?.pageInfo?.hasNextPage || false;

        cursor = edges.length ? edges[edges.length - 1].cursor : null;
      }

      /*
        IMPORTANT:
        uploadedMediaIds order == imageArray order == variants order (from CSV aggregation)
      */
      for (const edge of shopify_variants) {

        const variant = edge.node;

        const colorOption = variant.selectedOptions.find(
          (o: any) => o.name === "Color"
        );

        if (!colorOption) continue;

        const color = colorOption.value;

        const variantData = groupVariants.find(
          v => v.optionValues[1].name === color
        );

        const imageUrl = variantData?.imageUrl;
        const mediaId = imageUrlToMediaId.get(imageUrl);

        if (mediaId) {
          variantAssignments.push({
            id: variant.id,
            mediaId,
          });
        }
      }

      console.log(variantAssignments, "variantAssignments______");

      if (variantAssignments.length) {
        await admin.graphql(
          `#graphql
    mutation assignVariantMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`,
          { variables: { productId, variants: variantAssignments } }
        );
      }
      /* STEP 7: PUBLISH PRODUCT USING ENV ARRAY */

      let publicationIds: string[] = [];

      try {
        publicationIds = JSON.parse(
          process.env.SHOPIFY_PUBLICATION_IDS || "[]"
        );
      } catch (err) {
        console.error("Invalid SHOPIFY_PUBLICATION_IDS format in env");
      }

      if (!publicationIds.length) {
        console.warn("No publication IDs configured");
      } else {
        const publishInputs = publicationIds.map((id) => ({
          publicationId: id,
        }));

        const publishRes = await admin.graphql(
          `#graphql
    mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
          {
            variables: {
              id: productId,
              input: publishInputs,
            },
          }
        );

        const publishJson = await publishRes.json();
        const publishErrors = publishJson?.data?.publishablePublish?.userErrors;

        if (publishErrors?.length) {
          console.error("Publish Errors:", publishErrors);
        } else {
          console.log("Product published successfully");
          createdProducts.push(productId);
          productIndex++;
        }
      }
    }
    return Response.json({
      success: true,
      products: createdProducts,
    });
  } catch (error) {
    return Response.json(
      { error: "Unexpected server error", details: String(error) },
      { status: 500 }
    );
  }
};

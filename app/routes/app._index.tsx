import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

/* ================= SKELETON ================= */

function SkeletonBox({ width = "100%" }: { width?: string }) {
  return (
    <div
      style={{
        height: 14,
        width,
        borderRadius: 6,
        background:
          "linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%)",
        backgroundSize: "400% 100%",
        animation: "skeleton 1.4s ease infinite",
      }}
    />
  );
}

function ProductsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div style={skeletonCard}>
      <div style={skeletonRow(true)}>
        <SkeletonBox width="20%" />
        <SkeletonBox width="15%" />
        <SkeletonBox width="20%" />
        <SkeletonBox width="10%" />
        <SkeletonBox width="15%" />
        <SkeletonBox width="20%" />
      </div>

      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={skeletonRow()}>
          <SkeletonBox width="20%" />
          <SkeletonBox width="15%" />
          <SkeletonBox width="20%" />
          <SkeletonBox width="10%" />
          <SkeletonBox width="15%" />
          <SkeletonBox width="20%" />
        </div>
      ))}
    </div>
  );
}

/* ================= SERVER ================= */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];

  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: { title: `${color} Snowboard` },
      },
    },
  );

  const responseJson = await response.json();
  const product = responseJson.data!.productCreate!.product!;
  const variantId = product.variants.edges[0]!.node!.id!;

  await admin.graphql(
    `#graphql
    mutation updateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );

  return { product };
};

/* ================= UI ================= */

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // const [syncStatus, setSyncStatus] = useState<"idle" | "running" | "done">("idle");
  const [syncStatus, setSyncStatus] = useState<
    "checking" | "running" | "done"
  >("checking");
  const [products, setProducts] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  function setRowLoading(style: string, value: boolean) {
    setLoadingMap((prev) => ({ ...prev, [style]: value }));
  }

  // async function syncInventoryForExisting(productsList: any[]) {
  //   for (const p of productsList) {
  //     if (!p.existsInStore || !p.productId) continue;

  //     try {
  //       await fetch("/api/products/sync-inventory", {
  //         method: "POST",
  //         headers: { "Content-Type": "application/json" },
  //         body: JSON.stringify({
  //           style: p.style,
  //           productId: p.productId,
  //         }),
  //       });
  //     } catch (err) {
  //       console.error("Inventory sync failed for", p.style, err);
  //     }
  //   }
  // }

  // useEffect(() => {
  //   async function checkStatus() {
  //     const res = await fetch("/api/sync/status");
  //     const data = await res.json();

  //     // KEY FIX
  //     if (!data.ready) {
  //       setSyncStatus("running");
  //       startPolling();
  //     } else {
  //       setSyncStatus("done");
  //       loadProducts(1);
  //     }
  //   }

  //   checkStatus();
  // }, []);
  useEffect(() => {
    async function checkStatus() {
      const res = await fetch("/api/sync/status");
      const data = await res.json();

      if (!data.ready) {
        setSyncStatus("running");
        startPolling();
      } else {
        setSyncStatus("done");
        loadProducts(1);
      }
    }

    checkStatus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 700); // 700ms debounce

    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (syncStatus !== "done") return;

    setPage(1);
    loadProducts(1, debouncedSearch);
  }, [debouncedSearch]);
  useEffect(() => {
    if (syncStatus !== "done") return;
    setPage(1);
    loadProducts(1, debouncedSearch);
  }, [filter]);
  useEffect(() => {
    const hasCreating = products.some((p) => p.isProcessing);

    if (!hasCreating) return;

    const interval = setInterval(() => {
      loadProducts(page, search, true);
    }, 3000); // 3 sec

    return () => clearInterval(interval);
  }, [products, page]);
  async function loadProducts(pageNumber: number, searchValue = search, isPolling = false) {
    if (!isPolling) {
      setLoadingProducts(true);
    }
    // setLoadingProducts(true);

    const res = await fetch(
      `/api/products?page=${pageNumber}&search=${encodeURIComponent(searchValue)}&filter=${filter}`
    );

    const data = await res.json();

    setProducts(data.products || []);
    // setProducts(prev => {
    //   const newData = data.products || [];

    //   return newData.map((newItem: any) => {
    //     const existing = prev.find(p => p.style === newItem.style);

    //     return {
    //       ...newItem,
    //       isCreating: newItem.existsInStore
    //         ? false // auto stop
    //         : existing?.isCreating || false,
    //     };
    //   });
    // });
    setTotalPages(data.totalPages || 1);
    setPage(data.page || 1);

    if (!isPolling) {
      setLoadingProducts(false);
    }
  }
  function startPolling() {
    const interval = setInterval(async () => {
      const res = await fetch("/api/sync/status");
      const data = await res.json();

      if (data.ready) {
        clearInterval(interval);
        setSyncStatus("done");
        shopify.toast.show("sync completed successfully");
        loadProducts(1);
      }
    }, 5000);
  }

  // async function startSync() {
  //   setSyncStatus("running");
  //   await fetch("/api/sync/start");
  //   startPolling();
  // }
  async function handleDeleteConfirmed() {
    if (!selectedProduct?.productIds?.length) return;

    const style = selectedProduct.style;
    setRowLoading(style, true);

    try {
      await fetch("/api/product/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: selectedProduct.productIds
        }),
      });

      shopify.toast.show("Products disconnected successfully");
      await loadProducts(page, search, true);
    } finally {
      setRowLoading(style, false);
      setSelectedProduct(null);
    }
  }
  async function startSync() {
    setSyncStatus("running");
    setProducts([]);
    setPage(1);
    setTotalPages(1);
    setLoadingProducts(true);

    shopify.toast.show("Starting fresh sync...");

    await fetch("/api/sync/start");
    startPolling();
  }
  if (syncStatus === "checking") {
    return (
      <s-page heading="Products" inlineSize="large">
        <s-section>
          <s-stack>
            <s-paragraph>Checking sync status...</s-paragraph>
          </s-stack>
        </s-section>
        <s-button variant="primary" slot="primary-action" onClick={startSync}>
          Re-run Sync
        </s-button>
      </s-page>
    );
  }
  return (
    <s-page heading="Products" inlineSize="large">
      <s-button variant="primary" slot="primary-action" onClick={startSync}>
        Re-run Sync
      </s-button>
      <s-query-container>
        {/* Sync Section */}
        {syncStatus === "done" ? (<s-grid alignItems="end" paddingBlock="base" justifyItems="end">
          <s-grid-item>
          </s-grid-item>
        </s-grid>) : <s-section heading="Products Sync">
          <s-stack>
            <s-button
              onClick={startSync}
              disabled={syncStatus === "running"}
              {...(syncStatus === "running" ? { loading: true } : {})}
            >
              {syncStatus === "running"
                ? "Sync Running..." : "Re-run Sync"
              }
            </s-button>
            {syncStatus === "running" && (
              <s-paragraph>
                Sync in progress. Please wait...
              </s-paragraph>
            )}

            {/* {syncStatus === "done" && (
            <s-paragraph>
              Sync completed. Cached data ready.
            </s-paragraph>
          )} */}
          </s-stack>
        </s-section>}

        {/* Products */}
        {syncStatus === "done" && (
          <s-section>
            <s-grid paddingBlockEnd="base" gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-grid-item>
                <s-text-field
                  value={search}
                  placeholder="Search by product name, style, or category..."
                  icon="search"
                  onInput={(e: any) => {
                    const value = e.target.value;
                    setSearch(value);
                  }}
                />
              </s-grid-item>

              <s-grid-item>
                <s-select
                  value={filter}
                  onChange={(e: any) => setFilter(e.target.value)}
                >
                  <s-option value="all">All Products</s-option>
                  <s-option value="added">Synced to Shopify</s-option>
                  <s-option value="not_added">Not Synced Yet</s-option>
                </s-select>
              </s-grid-item>
            </s-grid>
            {loadingProducts ? (
              <ProductsSkeleton rows={10} />
            ) : (
              <>

                <s-table loading={false}>

                  <s-table-header-row>
                    <s-table-header>Title</s-table-header>
                    <s-table-header>Style</s-table-header>
                    <s-table-header>Category</s-table-header>
                    <s-table-header format="numeric">Variants</s-table-header>
                    <s-table-header format="numeric">Total Inventory</s-table-header>
                    <s-table-header format="numeric">Action</s-table-header>
                  </s-table-header-row>
                  <s-table-body>

                    {
                      products.map((p) => {
                        const rowLoading = loadingMap[p.style] === true;

                        return (
                          <s-table-row key={p.style}>
                            <s-table-cell>
                              <s-stack direction="inline" gap="small-300"
                                alignItems="center">
                                <s-box blockSize="50px" inlineSize="50px">
                                  <s-image
                                    objectFit="contain"
                                    alt="Ocean Sunset puzzle thumbnail"
                                    src={p?.image}
                                    border="base strong" borderRadius="base"
                                  />
                                </s-box>
                                <s-paragraph lineClamp={1}>{p.title}</s-paragraph>
                                {/* <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <s-box blockSize="50px" inlineSize="50px">
                                  <s-image
                                    objectFit="contain"
                                    alt="Ocean Sunset puzzle thumbnail"
                                    src={p?.image}
                                    border="base strong" borderRadius="base"
                                  />
                                </s-box>
                                <s-paragraph lineClamp={1}>{p.title}</s-paragraph>
                              </div> */}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>{p.style}</s-table-cell>
                            <s-table-cell>{p.category}</s-table-cell>
                            <s-table-cell>{p.totalVariants}</s-table-cell>
                            <s-table-cell>{p.totalInventory}</s-table-cell>

                            {/* <s-table-cell>
                              {p.isCreating ? (
                                <s-button disabled loading>
                                  add
                                </s-button>
                              ) : p.existsInStore ? (
                                <s-button
                                  tone="critical"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  commandFor="delete-modal"
                                  onClick={() => {
                                    if (!p.productIds?.length) return;
                                    setSelectedProduct(p);
                                  }}
                                >
                                  Delete
                                </s-button>
                              ) : (
                                <s-button
                                  tone="auto"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  // onClick={async () => {
                                  //   setRowLoading(p.style, true);
                                  //   try {
                                  //     await fetch("/api/products/add", {
                                  //       method: "POST",
                                  //       body: JSON.stringify({ style: p.style }),
                                  //       headers: { "Content-Type": "application/json" },
                                  //     });

                                  //     shopify.toast.show("Product creation started...");

                                  //     // 🔥 IMPORTANT
                                  //     await loadProducts(page);

                                  //   } finally {
                                  //     setRowLoading(p.style, false);
                                  //   }
                                  // }}
                                  onClick={async () => {
                                    setRowLoading(p.style, true);

                                    // 🔥 ADD THIS (MOST IMPORTANT)
                                    setProducts(prev =>
                                      prev.map(item =>
                                        item.style === p.style
                                          ? { ...item, isCreating: true }
                                          : item
                                      )
                                    );

                                    try {
                                      await fetch("/api/products/add", {
                                        method: "POST",
                                        body: JSON.stringify({ style: p.style }),
                                        headers: { "Content-Type": "application/json" },
                                      });

                                      shopify.toast.show("Product creation started...");

                                      // ❌ immediate reload hata bhi sakte ho (optional)
                                      // await loadProducts(page);

                                    } finally {
                                      setRowLoading(p.style, false);
                                    }
                                  }}
                                >
                                  Add
                                </s-button>
                              )}
                            </s-table-cell> */}
                            {/* <s-table-cell>
                              {p.isProcessing ? (
                                <s-button disabled loading>
                                  add
                                </s-button>
                              ) : p.existsInStore ? (
                                <s-button
                                  tone="critical"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  commandFor="delete-modal"
                                  onClick={() => {
                                    if (!p.productIds?.length) return;
                                    setSelectedProduct(p);
                                  }}
                                >
                                  Disconnect
                                </s-button>
                              ) : (
                                <s-button
                                  tone="auto"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  onClick={async () => {
                                    setRowLoading(p.style, true);

                                    try {
                                      await fetch("/api/products/add", {
                                        method: "POST",
                                        body: JSON.stringify({ style: p.style }),
                                        headers: { "Content-Type": "application/json" },
                                      });

                                      shopify.toast.show("Product creation started...");
                                      await loadProducts(page, search, true);

                                    } finally {
                                      setRowLoading(p.style, false);
                                    }
                                  }}
                                >
                                  Add
                                </s-button>
                              )}
                            </s-table-cell> */}
                            <s-table-cell>
                              {p.isProcessing ? (
                                <s-button disabled loading>
                                  Processing
                                </s-button>

                              ) : p.existsInStore && !p.sync_status ? (
                                <s-button
                                  tone="neutral"
                                  variant="primary"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  onClick={async () => {
                                    setRowLoading(p.style, true);

                                    try {
                                      await fetch("/api/products/connect", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          productIds: p.productIds,
                                        }),
                                      });

                                      shopify.toast.show("Product connected successfully");
                                      await loadProducts(page, search, true);

                                    } finally {
                                      setRowLoading(p.style, false);
                                    }
                                  }}
                                >
                                  Connect
                                </s-button>

                              ) : p.existsInStore && p.sync_status ? (
                                // ❌ DISCONNECT CASE
                                <s-button
                                  tone="critical"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  commandFor="delete-modal"
                                  onClick={() => {
                                    if (!p.productIds?.length) return;
                                    setSelectedProduct(p);
                                  }}
                                >
                                  Disconnect
                                </s-button>

                              ) : (
                                // ➕ ADD CASE
                                <s-button
                                  tone="auto"
                                  disabled={rowLoading}
                                  {...(rowLoading ? { loading: true } : {})}
                                  onClick={async () => {
                                    setRowLoading(p.style, true);

                                    try {
                                      await fetch("/api/products/add", {
                                        method: "POST",
                                        body: JSON.stringify({ style: p.style }),
                                        headers: { "Content-Type": "application/json" },
                                      });

                                      shopify.toast.show("Product creation started...");
                                      await loadProducts(page, search, true);

                                    } finally {
                                      setRowLoading(p.style, false);
                                    }
                                  }}
                                >
                                  Add
                                </s-button>
                              )}
                            </s-table-cell>
                          </s-table-row>
                        );
                      })

                    }
                  </s-table-body>
                </s-table>
                {products.length === 0 && <s-stack
                  minBlockSize={innerHeight < 500 ? "200px" : "340px"}
                  direction="block"
                  alignItems="center"
                  justifyContent="center"
                  paddingBlock="large"
                >
                  <s-text color="subdued">No data found</s-text>
                </s-stack>}
                {/* Pagination only after load */}
                <s-stack
                  gap="base"
                  paddingBlockStart="base"
                  direction="inline"
                  alignItems="center"
                  justifyContent="end"
                >
                  <s-button
                    disabled={page === 1}
                    onClick={() => loadProducts(page - 1, search)}
                  >
                    Previous
                  </s-button>

                  <s-text>
                    Page {page} / {totalPages}
                  </s-text>

                  <s-button
                    disabled={page === totalPages}
                    onClick={() => loadProducts(page + 1, search)}
                  >
                    Next
                  </s-button>
                </s-stack>
              </>
            )}

          </s-section>
        )}
        <s-modal id="delete-modal" heading="Delete Product">
          <s-paragraph>
            Are you sure you want to disconnect all Shopify products for "{selectedProduct?.title}"?
          </s-paragraph>

          <s-button
            slot="secondary-actions"
            commandFor="delete-modal"
            command="--hide"
            onClick={() => {
              setSelectedProduct(null);
            }}
          >
            Cancel
          </s-button>

          <s-button
            slot="primary-action"
            variant="primary"
            tone="critical"
            commandFor="delete-modal"
            command="--hide"
            onClick={handleDeleteConfirmed}
          >
            Disconnect
          </s-button>
        </s-modal>
      </s-query-container>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/* ================= STYLES ================= */

const skeletonCard = {
  padding: "16px",
  borderRadius: "12px",
  background: "#fff",
  boxShadow: "0 1px 6px rgba(0,0,0,0.08)",
};

const skeletonRow = (header = false) => ({
  display: "grid",
  gridTemplateColumns: "2fr 1fr 2fr 1fr 1fr 1fr",
  gap: "16px",
  padding: "10px 0",
  borderBottom: header ? "2px solid #e5e7eb" : "1px solid #e5e7eb",
});

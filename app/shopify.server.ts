// import "@shopify/shopify-app-react-router/adapters/node";
// import {
//   ApiVersion,
//   AppDistribution,
//   shopifyApp,
// } from "@shopify/shopify-app-react-router/server";
// import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
// import prisma from "./db.server";

// const shopify = shopifyApp({
//   apiKey: process.env.SHOPIFY_API_KEY,
//   apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
//   apiVersion: ApiVersion.October25,
//   scopes: process.env.SCOPES?.split(","),
//   appUrl: process.env.SHOPIFY_APP_URL || "",
//   authPathPrefix: "/auth",
//   sessionStorage: new PrismaSessionStorage(prisma),
//   distribution: AppDistribution.AppStore,
//   future: {
//     expiringOfflineAccessTokens: true,
//   },
//   ...(process.env.SHOP_CUSTOM_DOMAIN
//     ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
//     : {}),
// });

// export default shopify;
// export const apiVersion = ApiVersion.October25;
// export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
// export const authenticate = shopify.authenticate;
// export const unauthenticated = shopify.unauthenticated;
// export const login = shopify.login;
// export const registerWebhooks = shopify.registerWebhooks;
// export const sessionStorage = shopify.sessionStorage;



import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import fs from "fs";
import path from "path";
// import background sync starter
import { downloadSanmarCSV } from "./lib/sanmar.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },

  // AFTER INSTALL HOOK
  // hooks: {
  //   afterAuth: async ({ session }) => {
  //     console.log(` App installed for shop: ${session.shop}`);
  //     // Run background sync (non-blocking)
  //     (async () => {
  //       try {
  //         console.log(" Starting background SanMar sync after install...");

  //         await downloadSanmarCSV();
  //         console.log(" SanMar sync completed after install.");
  //       } catch (err) {
  //         console.error(" SanMar sync failed:", err);
  //       }
  //     })();
  //   },
  // },
  hooks: {
    afterAuth: async ({ session }) => {
      console.log(`App installed for shop: ${session.shop}`);

      try {
        // ✅ Only store offline session
        if (!session.isOnline) {
          const scriptsDir = path.join(process.cwd(), "scripts");
          const filePath = path.join(scriptsDir, "offline-sessions.json");

          // Create scripts folder if not exists
          if (!fs.existsSync(scriptsDir)) {
            fs.mkdirSync(scriptsDir, { recursive: true });
          }

          let existingSessions: any[] = [];

          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf-8");
            existingSessions = raw ? JSON.parse(raw) : [];
          }

          // Remove old session of same shop
          existingSessions = existingSessions.filter(
            (s) => s.shop !== session.shop
          );

          // Add new session
          existingSessions.push({
            shop: session.shop,
            accessToken: session.accessToken,
          });
          fs.writeFileSync(
            filePath,
            JSON.stringify(existingSessions, null, 2)
          );

          console.log("Offline session saved to JSON file.");
        }
      } catch (err) {
        console.error("Failed to store session JSON:", err);
      }

      // Run background sync (non-blocking)
      (async () => {
        try {
          console.log("Starting background SanMar sync after install...");
          await downloadSanmarCSV();
          console.log("SanMar sync completed after install.");
        } catch (err) {
          console.error("SanMar sync failed:", err);
        }
      })();
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

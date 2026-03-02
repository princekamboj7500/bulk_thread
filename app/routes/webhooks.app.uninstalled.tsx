import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete Shopify sessions
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  //  Clear SanMar sync cache on uninstall
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
      console.log(" Deleted SanMar cache file after uninstall.");
    }

    if (fs.existsSync(CSV_FILE)) {
      fs.unlinkSync(CSV_FILE);
      console.log(" Deleted SanMar CSV file after uninstall.");
    }
  } catch (err) {
    console.error(" Failed to clean cache files on uninstall:", err);
  }

  return new Response();
};

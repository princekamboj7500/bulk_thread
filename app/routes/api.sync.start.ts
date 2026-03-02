import { downloadSanmarCSV } from "../lib/sanmar.server";

let running = false;

export async function loader() {
  if (running) {
    return JSON.stringify({ status: "already-running" });
  }

  running = true;

  (async () => {
    try {
      console.log("Force background sync started...");
      await downloadSanmarCSV({ force: true });
      console.log(" Background sync finished.");
    } catch (err) {
      console.error(" Background sync failed:", err);
    } finally {
      running = false;
    }
  })();

  return JSON.stringify({ status: "started" });
}

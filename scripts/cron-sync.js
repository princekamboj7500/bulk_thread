// import "dotenv/config";
// async function run() {
//   try {
//     console.log("Running silent scheduled sync...");

//     // Dynamically import TS server module
//     const mod = await import("../app/lib/sanmar.server.ts");

//     await mod.downloadSanmarCSV({ force: true });

//     console.log("Scheduled sync completed successfully");
//     process.exit(0);
//   } catch (err) {
//     console.error("Scheduled sync failed:", err);
//     process.exit(1);
//   }
// }

// run();



import "dotenv/config";

async function run() {
  try {
    console.log("Running silent scheduled sync...");
    const { downloadSanmarCSV } = await import(
      new URL("../app/lib/sanmar.server.ts", import.meta.url)
    );
    await downloadSanmarCSV({ force: true });
    console.log("Scheduled sync completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Scheduled sync failed:", err);
    process.exit(1);
  }
}
run();

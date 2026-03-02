import fs from "fs";
import path from "path";
import Papa from "papaparse";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");

export async function downloadSanmarCSV(options?: { force?: boolean }) {
  const force = options?.force === true;

  if (!force && fs.existsSync(CACHE_FILE)) {
    console.log("Using cached SanMar data...");
    return true;
  }

  // If force rerun → delete cache + csv
  if (force) {
    console.log("Force sync enabled → clearing old cache...");
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
  }

  const SftpClient = (await import("ssh2-sftp-client")).default;
  const AdmZip = (await import("adm-zip")).default;

  const sftp = new SftpClient();

  console.log(" Connecting to SanMar SFTP...");

  await sftp.connect({
    host: process.env.SANMAR_Domain!,
    username: process.env.SANMAR_USER!,
    password: process.env.SANMAR_PASS!,
    port: 2200,
    readyTimeout: 60000,
  });

  console.log(" Downloading EPDD zip...");
  const zipBuffer = await sftp.get("/SanMarPDD/SanMar_EPDD_csv.zip");
  await sftp.end();

  console.log(" Unzipping CSV...");
  const zip = new AdmZip(zipBuffer as Buffer);
  const csvEntry = zip
    .getEntries()
    .find((e: any) => e.entryName.toLowerCase().endsWith(".csv"));

  if (!csvEntry) throw new Error("CSV not found in ZIP");

  const csvBuffer = csvEntry.getData();
  fs.writeFileSync(CSV_FILE, csvBuffer);

  console.log(" Parsing CSV → streaming to cache...");

  // return new Promise((resolve, reject) => {
  //   const fileStream = fs.createReadStream(CSV_FILE);
  //   const writeStream = fs.createWriteStream(CACHE_FILE);

  //   writeStream.write("[\n");
  //   let isFirst = true;
  //   let count = 0;

  //   Papa.parse(fileStream as any, {
  //     header: true,
  //     skipEmptyLines: true,

  //     step: (result) => {
  //       const json = JSON.stringify(result.data);

  //       if (!isFirst) writeStream.write(",\n");
  //       writeStream.write(json);

  //       isFirst = false;
  //       count++;
  //     },

  //     complete: () => {
  //       writeStream.write("\n]");
  //       writeStream.end();
  //       console.log(` Parsed ${count} rows & cache rebuilt`);
  //       resolve(true);
  //     },

  //     error: (err) => {
  //       console.error("CSV Parsing Error:", err);
  //       reject(err);
  //     },
  //   });
  // });
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(CSV_FILE);
    const writeStream = fs.createWriteStream(CACHE_FILE);

    writeStream.write("[\n");

    let buffer: string[] = [];
    let count = 0;
    const BATCH_SIZE = 500;
    let isFirstRow = true;

    function flushBuffer() {
      if (buffer.length === 0) return;

      const chunk =
        (isFirstRow ? "" : ",\n") + buffer.join(",\n");

      buffer = [];
      isFirstRow = false;

      if (!writeStream.write(chunk)) {
        fileStream.pause();
        writeStream.once("drain", () => fileStream.resume());
      }
    }

    Papa.parse(fileStream as any, {
      header: true,
      skipEmptyLines: true,

      step: (result) => {
        const json = JSON.stringify(result.data);
        buffer.push(json);
        count++;

        if (buffer.length >= BATCH_SIZE) {
          flushBuffer();
        }
      },

      complete: () => {
        flushBuffer();

        writeStream.write("\n]");
        writeStream.end(() => {
          console.log(`Parsed ${count} rows & cache rebuilt`);
          resolve(true);
        });
      },

      error: (err) => {
        console.error("CSV Parsing Error:", err);
        reject(err);
      },
    });
  });
}

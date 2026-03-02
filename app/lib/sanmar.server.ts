import fs from "fs";
import path from "path";
import Papa from "papaparse";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");
const CSV_FILE = path.join(process.cwd(), "SanMar_EPDD.csv");
const ZIP_FILE = path.join(process.cwd(), "SanMar_EPDD.zip");

export async function downloadSanmarCSV(options?: { force?: boolean }) {
  const force = options?.force === true;

  if (!force && fs.existsSync(CACHE_FILE)) {
    console.log("Using cached SanMar data...");
    return true;
  }

  if (force) {
    console.log("Force sync enabled → clearing old cache...");
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
    if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
  }

  const SftpClient = (await import("ssh2-sftp-client")).default;
  // const AdmZip = (await import("adm-zip")).default;
  const unzipper = await import("unzipper");
  const sftp = new SftpClient();

  console.log("Connecting to SanMar SFTP...");

  await sftp.connect({
    host: process.env.FTP_DOMAIN_SANMAR!,
    username: process.env.FTP_USERNAME_SANMAR!,
    password: process.env.FTP_PASSWORD_SANMAR!,
    port: 2200,
    readyTimeout: 60000,
  });

  console.log("Downloading EPDD zip to disk...");
  await sftp.fastGet("/SanMarPDD/SanMar_EPDD_csv.zip", ZIP_FILE);
  await sftp.end();

  console.log("Unzipping CSV from disk...");
  // const zip = new AdmZip(ZIP_FILE);
  // const csvEntry = zip
  //   .getEntries()
  //   .find((e: any) => e.entryName.toLowerCase().endsWith(".csv"));

  // if (!csvEntry) throw new Error("CSV not found in ZIP");

  // zip.extractEntryTo(csvEntry.entryName, process.cwd(), false, true);
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(ZIP_FILE)
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        const fileName = entry.path.toLowerCase();

        if (fileName.endsWith(".csv")) {
          entry.pipe(fs.createWriteStream(CSV_FILE))
            .on("finish", resolve)
            .on("error", reject);
        } else {
          entry.autodrain(); // skip other files
        }
      })
      .on("error", reject);
  });
  // Optional: delete zip after extraction to save space
  if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

  console.log("Parsing CSV → streaming to cache...");

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

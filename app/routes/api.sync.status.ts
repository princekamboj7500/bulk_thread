import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "sanmar-cache.json");

export async function loader() {
  if (!fs.existsSync(CACHE_FILE)) {
    return Response.json({ ready: false, running: false });
  }

  try {
    const stat = fs.statSync(CACHE_FILE);

    // empty file means still creating
    if (stat.size < 10) {
      return Response.json({ ready: false, running: true });
    }

    // read last few bytes only (memory safe)
    const fd = fs.openSync(CACHE_FILE, "r");
    const buffer = Buffer.alloc(10);
    fs.readSync(fd, buffer, 0, 10, stat.size - 10);
    fs.closeSync(fd);

    const tail = buffer.toString();

    const completed = tail.includes("]");

    return Response.json({
      ready: completed,
      running: !completed,
    });
  } catch (err) {
    console.error("Status check error:", err);
    return Response.json({ ready: false, running: true });
  }
}

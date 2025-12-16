import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import archiver from "archiver";
import pLimit from "p-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_PATH = path.join(__dirname, "template.png");

// Vaste plek van het vierkant in template.png
const SQUARE_LEFT = 225;   // x
const SQUARE_TOP = 493;    // y
const SQUARE_SIZE = 520;   // breedte en hoogte

// Output
const OUTPUT_DIR = path.join(__dirname, "out");
const OUTPUT_ZIP = path.join(__dirname, "out.zip");
const OUTPUT_FORMAT = "jpg"; // "jpg" of "png"
const JPG_QUALITY = 90;

// Interne parallelisatie, veilig op GitHub runner
const CONCURRENCY = 6;

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function ensureCleanDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function zipDir(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function main() {
  const batchPath = process.env.BATCH_JSON_PATH || path.join(__dirname, "batch.json");
  const raw = fs.readFileSync(batchPath, "utf8");
  const parsed = JSON.parse(raw);

  // We verwachten dat batch.json direct een array is: [ {...}, {...} ]
  // Maar we accepteren ook { items: [...] } of { batch_json: "[...]" } voor de zekerheid.
  const items =
    Array.isArray(parsed) ? parsed :
    (Array.isArray(parsed?.items) ? parsed.items :
    (typeof parsed?.batch_json === "string" ? JSON.parse(parsed.batch_json) : null));

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Geen items gevonden. Verwacht een array, of een object met items, of batch_json.");
  }

  const templateBuf = fs.readFileSync(TEMPLATE_PATH);

  ensureCleanDir(OUTPUT_DIR);
  if (fs.existsSync(OUTPUT_ZIP)) fs.rmSync(OUTPUT_ZIP, { force: true });

  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    items.map((item, idx) =>
      limit(async () => {
        const { imageUrl, outputName, colorName } = item;

        if (!imageUrl) throw new Error(`item ${idx} mist imageUrl`);

        // Als je liever colorName gebruikt als bestandsnaam, dan pakt hij die.
        const nameCandidate = outputName || colorName || `output_${idx + 1}`;
        const safeName = String(nameCandidate).replace(/[^a-zA-Z0-9._-]/g, "_");

        const imgBuf = await fetchBuffer(imageUrl);

        const square = await sharp(imgBuf)
          .resize(SQUARE_SIZE, SQUARE_SIZE, { fit: "cover", position: "centre" })
          .toBuffer();

        let base = sharp(templateBuf).composite([
          { input: square, left: SQUARE_LEFT, top: SQUARE_TOP }
        ]);

        if (OUTPUT_FORMAT === "png") {
          base = base.png();
        } else {
          base = base.jpeg({ quality: JPG_QUALITY });
        }

        const outPath = path.join(OUTPUT_DIR, `${safeName}.${OUTPUT_FORMAT}`);
        await base.toFile(outPath);
      })
    )
  );

  await zipDir(OUTPUT_DIR, OUTPUT_ZIP);
  console.log(`Klaar. Zip: ${OUTPUT_ZIP}`);
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});

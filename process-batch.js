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
const SQUARE_TOP = 473;    // y
const SQUARE_SIZE = 520;   // breedte en hoogte
// Tekst instellingen
const TEXT_LEFT = 260;      // x positie van de tekstlaag
const TEXT_TOP = 400;      // y positie van de tekstlaag
const TEXT_WIDTH = 450;    // breedte van het tekstvak
const TEXT_HEIGHT = 70;    // hoogte van het tekstvak

const TEXT_FONT_FAMILY = "Montserrat";
const TEXT_FONT_WEIGHT = 600; // SemiBold
const TEXT_SIZE = 41;
const TEXT_COLOR = "#252422";
const TEXT_ALIGN = "left";

// Output
const OUTPUT_DIR = path.join(__dirname, "out");
const OUTPUT_ZIP = path.join(__dirname, "out.zip");
const OUTPUT_FORMAT = "png"; // "jpg" of "png"
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
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const FONT_PATH = path.join(__dirname, "fonts", "Montserrat-SemiBold.ttf");
const FONT_BASE64 = fs.readFileSync(FONT_PATH).toString("base64");

if (!fs.existsSync(FONT_PATH)) {
  throw new Error(`Fontbestand niet gevonden: ${FONT_PATH}`);
}


function makeTextSvg(text) {
  const safe = escapeXml(text);

  const anchor = TEXT_ALIGN === "center" ? "middle" : TEXT_ALIGN === "right" ? "end" : "start";
  const x = TEXT_ALIGN === "center" ? "50%" : TEXT_ALIGN === "right" ? "100%" : "0";

  return Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_WIDTH}" height="${TEXT_HEIGHT}">
    <style>
      @font-face {
        font-family: '${TEXT_FONT_FAMILY}';
        src: url('data:font/ttf;base64,${FONT_BASE64}') format('truetype');
        font-weight: ${TEXT_FONT_WEIGHT};
        font-style: normal;
      }
      .t {
        font-family: '${TEXT_FONT_FAMILY}';
        font-weight: ${TEXT_FONT_WEIGHT};
        font-size: ${TEXT_SIZE}px;
        fill: ${TEXT_COLOR};
      }
    </style>

    <text
      x="${x}"
      y="50%"
      text-anchor="${anchor}"
      dominant-baseline="middle"
      class="t"
    >${safe}</text>
  </svg>
`);
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

        const label = item.colorName || item.outputName || `kleur_${idx + 1}`;
        const labelSvg = makeTextSvg(label);

        let base = sharp(templateBuf).composite([
          { input: square, left: SQUARE_LEFT, top: SQUARE_TOP },
          { input: labelSvg, left: TEXT_LEFT, top: TEXT_TOP }
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

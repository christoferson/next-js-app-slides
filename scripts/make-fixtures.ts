/**
 * Generates PNG fixtures for the pptxgenjs spike (§1.1) with zero image deps.
 * Grid + corner markers make full-bleed / distortion / letterbox visible by eye.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgb(x,y) -> [r,g,b] */
type Painter = (x: number, y: number, w: number, h: number) => [number, number, number];

function png(w: number, h: number, paint: Painter): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y, w, h);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Dark brand background: 10% grid + magenta 1%-inset border + corner blocks. */
const brandBg: Painter = (x, y, w, h) => {
  const fx = x / w, fy = y / h;
  const nearEdge = fx < 0.01 || fx > 0.99 || fy < 0.01 || fy > 0.99;
  if (nearEdge) return [255, 0, 170];                  // full-bleed tell: magenta must touch slide edges
  if (fx < 0.06 && fy < 0.06) return [255, 214, 0];    // TL corner marker
  if (fx > 0.94 && fy > 0.94) return [0, 214, 255];    // BR corner marker
  const grid = (x % Math.round(w / 10) === 0) || (y % Math.round(h / 10) === 0);
  if (grid) return [70, 70, 110];
  return [26, 26, 46];
};

/** Same brand background with deterministic dither — gives a realistic PNG weight for the dedup probe. */
const noisyBrandBg: Painter = (x, y, w, h) => {
  const [r, g, b] = brandBg(x, y, w, h);
  const n = ((x * 2654435761 + y * 40503) % 23) - 11;
  const cl = (v: number) => Math.max(0, Math.min(255, v + n));
  return [cl(r), cl(g), cl(b)];
};

/** Logo: white ring on transparent-ish light square (no alpha channel; uses a flat key colour). */
const logo: Painter = (x, y, w, h) => {
  const dx = x / w - 0.5, dy = y / h - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);
  return r > 0.32 && r < 0.46 ? [255, 255, 255] : [10, 10, 20];
};

const out = join(process.cwd(), "fixtures");
mkdirSync(out, { recursive: true });

const files: Array<[string, Buffer]> = [
  ["bg-16x9.png", png(960, 540, brandBg)],   // exact 16:9
  ["bg-4x3.png", png(800, 600, brandBg)],    // letterbox case
  ["logo.png", png(128, 128, logo)],
  ["bg-1920.png", png(1920, 1080, noisyBrandBg)],  // realistic weight, for §1.1 H–K
];
for (const [name, buf] of files) {
  writeFileSync(join(out, name), buf);
  console.log(`fixture ${name.padEnd(14)} ${buf.length} bytes`);
}

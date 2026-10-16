// Regenerate the multi-resolution Windows icon from the shared SVG.
// Requires: npm ci && npx playwright install chromium
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile(new URL('../web/icon.svg', import.meta.url), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => new Resvg(svg, {
  fitTo: { mode: 'width', value: size },
}).render().asPng());
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = size % 256;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
await writeFile(new URL('../web/icon.ico', import.meta.url), Buffer.concat([header, ...images]));

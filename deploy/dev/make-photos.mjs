// Makes dev's test photos in /out. Run by ./memento dev up, in Immich's server image.
import { createRequire } from 'node:module';

const require = createRequire('/usr/src/app/server/package.json');
const sharp = require('sharp');

const scene = (width, height, label) => {
  const lines = [];
  const step = Math.round(Math.max(width, height) / 40);
  for (let x = step; x < width; x += step) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="${Math.max(1, step / 60)}"/>`);
  }
  for (let y = step; y < height; y += step) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="${Math.max(1, step / 60)}"/>`);
  }
  const font = Math.round(Math.min(width, height) / 8);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d4e89"/><stop offset="0.55" stop-color="#7fb7e6"/><stop offset="0.56" stop-color="#3f7d3a"/><stop offset="1" stop-color="#1f3d1c"/>
    </linearGradient>
    <radialGradient id="sun"><stop offset="0" stop-color="#fff6d5"/><stop offset="1" stop-color="#ffb347"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#sky)"/>
  <circle cx="${width * 0.75}" cy="${height * 0.25}" r="${Math.min(width, height) * 0.1}" fill="url(#sun)"/>
  <rect x="${width * 0.1}" y="${height * 0.6}" width="${width * 0.15}" height="${height * 0.25}" fill="#c0392b"/>
  <rect x="${width * 0.3}" y="${height * 0.65}" width="${width * 0.12}" height="${height * 0.2}" fill="#f1c40f"/>
  <rect x="${width * 0.5}" y="${height * 0.62}" width="${width * 0.1}" height="${height * 0.23}" fill="#8e44ad"/>
  ${lines.join('\n  ')}
  <text x="50%" y="45%" font-family="sans-serif" font-size="${font}" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="${font / 40}">${label}</text>
</svg>`);
};

await sharp(scene(8160, 6120, '50 MP ↑')).jpeg({ quality: 90 }).toFile('/out/big-50mp.jpg');

await sharp(await sharp(scene(3000, 4000, 'UP ↑')).png().toBuffer())
  .rotate(-90)
  .withMetadata({ orientation: 6 })
  .jpeg({ quality: 90 })
  .toFile('/out/portrait-exif6.jpg');

await sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
  <circle cx="800" cy="600" r="500" fill="#2e86de"/><circle cx="800" cy="600" r="250" fill="#f6b93b" fill-opacity="0.6"/>
  <text x="800" y="640" font-family="sans-serif" font-size="140" text-anchor="middle" fill="#ffffff">PNG</text>
</svg>`),
)
  .png()
  .toFile('/out/transparent.png');

await sharp(scene(4032, 3024, 'Goa')).jpeg({ quality: 90 }).toFile('/out/goa.jpg');
await sharp(scene(4032, 3024, 'Cropped')).jpeg({ quality: 90 }).toFile('/out/cropped.jpg');
console.log('made test photos');

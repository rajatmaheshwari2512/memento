// A fake Gemini for dev, on port 9911 (deploy/dev/memento.yml). It answers AI edits with the photo
// redrawn and "FAKE AI EDIT" across it. An instruction containing "WRONG SHAPE" gets a square back.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire('/usr/src/app/server/package.json');
const sharp = require('sharp');

const LONG_SIDE = { '1K': 1024, '2K': 2048, '4K': 4096 };
const MAX_BODY = 40 * 1024 * 1024;

const read = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const reply = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const edit = async (photo, size, wrongShape) => {
  const stored = sharp(photo);
  const { width, height } = await sharp(photo).metadata();
  const long = LONG_SIDE[size] ?? 2048;
  const scale = long / Math.max(width, height);
  const block = (n) => Math.max(16, Math.round((n * scale) / 16) * 16);
  const out = wrongShape ? { width: long, height: long } : { width: block(width), height: block(height) };
  const font = Math.round(Math.min(out.width, out.height) / 10);
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}">` +
      `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${font}" ` +
      `fill="#ffffff" fill-opacity="0.55" stroke="#000" stroke-opacity="0.4">FAKE AI EDIT</text></svg>`,
  );
  const crop = {
    left: Math.round(width * 0.003),
    top: Math.round(height * 0.004),
    width: width - Math.round(width * 0.006),
    height: height - Math.round(height * 0.006),
  };
  return sharp(await stored.toBuffer())
    .extract(crop)
    .resize(out.width, out.height, { fit: 'fill' })
    .modulate({ hue: 150, saturation: 1.6, brightness: 1.05 })
    .blur(1.2)
    .composite([{ input: label }])
    .jpeg({ quality: 88 })
    .toBuffer();
};

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1beta/interactions')) return reply(res, 404, {});
  try {
    const body = await read(req);
    const text = body.input.find((part) => part.type === 'text')?.text ?? '';
    const images = body.input.filter((part) => part.type === 'image');
    const size = body.response_format?.image_size;
    console.log(JSON.stringify({ size, images: images.length, imageBytes: images.map((i) => Math.round((i.data.length * 3) / 4)), instruction: text.slice(-90) }));
    const result = await edit(Buffer.from(images[0].data, 'base64'), size, text.includes('WRONG SHAPE'));
    reply(res, 200, { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: result.toString('base64') }] }] });
  } catch (error) {
    console.error(error);
    reply(res, 400, { error: { message: String(error) } });
  }
}).listen(9911, '0.0.0.0', () => console.log('fake Gemini on :9911'));

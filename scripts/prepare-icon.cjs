// Preserve the approved artwork; fit its visible body instead of its source canvas.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const root = path.resolve(__dirname, '..');
  const source = nativeImage.createFromPath(path.join(root, 'src/assets/slime.png'));
  if (source.isEmpty()) throw new Error('Missing slime artwork');
  const { width, height } = source.getSize();
  const pixels = source.toBitmap();
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Ignore nearly invisible export residue when measuring the visible body.
    if (pixels[(y * width + x) * 4 + 3] < 16) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('Slime artwork has no visible pixels');
  // Keep a square crop and a small fringe for antialiasing, without stretching.
  const edge = Math.max(right - left + 1, bottom - top + 1) + 4;
  const cropX = Math.floor((left + right + 1 - edge) / 2);
  const cropY = Math.floor((top + bottom + 1 - edge) / 2);
  if (cropX < 0 || cropY < 0 || cropX + edge > width || cropY + edge > height) {
    throw new Error('Slime artwork needs room for its square icon crop');
  }
  const body = source.crop({ x: cropX, y: cropY, width: edge, height: edge });
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => {
    const inset = Math.max(1, Math.round(size / 32));
    const inner = size - 2 * inset;
    const scaled = body.resize({ width: inner, height: inner, quality: 'best' }).toBitmap();
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < inner; y++) {
      scaled.copy(canvas, ((y + inset) * size + inset) * 4, y * inner * 4, (y + 1) * inner * 4);
    }
    return nativeImage.createFromBitmap(canvas, { width: size, height: size }).toPNG();
  });
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12); offset += images[index].length;
  });
  fs.writeFileSync(path.join(root, 'src/assets/app.ico'), Buffer.concat([header, ...images]));
  console.log('Created app.ico with sizes: ' + sizes.join(', '));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

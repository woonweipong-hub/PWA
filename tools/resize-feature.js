const sharp = require('sharp');
const path = require('path');

const W = 1024, H = 500;
const input = path.join(__dirname, 'Head.JPG');
const output = path.join(__dirname, 'Feature.jpg');

(async () => {
  // Scale to COVER (fill entire canvas, crop overflow)
  await sharp(input)
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92 })
    .toFile(output);

  console.log(`Saved: ${output} (${W}x${H})`);
})();

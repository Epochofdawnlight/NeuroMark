import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { processDocumentImage } from '@main/services/documentScanService';

it('uses all decoded pixels of an imported page, including marks at the edges', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'neuromark-full-page-'));
  const original = path.join(folder, 'answer.png');
  const prepared = path.join(folder, 'scanned', 'answer.full-page.png');
  const width = 120;
  const height = 80;
  const pixels = Buffer.alloc(width * height * 3, 245);
  pixels[0] = 3;
  pixels[pixels.length - 1] = 47;
  try {
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(original);
    await processDocumentImage(original, prepared);
    const { data, info } = await sharp(prepared)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([width, height]);
    expect(data.equals(pixels)).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

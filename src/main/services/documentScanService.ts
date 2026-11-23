import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'fs-extra';
import sharp, { type Sharp } from 'sharp';

async function openScanSource(inputPath: string): Promise<Sharp> {
  if (path.extname(inputPath).toLowerCase() !== '.bmp') return sharp(inputPath);
  const bitmap = await loadImage(await fs.readFile(inputPath));
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return sharp(canvas.toBuffer('image/png'));
}

export async function processDocumentImage(
  inputPath: string,
  scannedPath: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(scannedPath));
  const temporary = path.join(
    path.dirname(scannedPath),
    `.page-${randomUUID()}.png`,
  );
  try {
    const source = await openScanSource(inputPath);
    await source.rotate().png().toFile(temporary);
    await fs.rename(temporary, scannedPath);
  } finally {
    await fs.remove(temporary);
  }
}

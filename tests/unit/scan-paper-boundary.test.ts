import { expect, it } from 'vitest';
import sharp from 'sharp';
import { hasPaperBoundary } from '@main/services/scanPaperBoundary';

const corners = [
  { x: 36, y: 49 },
  { x: 456, y: 32 },
  { x: 462, y: 285 },
  { x: 32, y: 282 },
];
const points = corners.map(({ x, y }) => `${x},${y}`).join(' ');

function image(background: string) {
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="320">
      <rect width="500" height="320" fill="${background}"/>
      <polygon points="${points}" fill="white" stroke="#222" stroke-width="2"/>
    </svg>`),
  );
}

it('preserves a flat answer sheet even if the scanner picks a slanted printed box', async () => {
  expect(await hasPaperBoundary(image('white'), 500, 320, corners)).toBe(false);
});

it('accepts a photographed page when all four paper edges border a darker background', async () => {
  expect(await hasPaperBoundary(image('#666'), 500, 320, corners)).toBe(true);
});

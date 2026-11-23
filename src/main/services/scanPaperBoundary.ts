import type { Sharp } from 'sharp';
import type { CornerPoint } from '@preload/contracts';

/**
 * The native detector proposes a quadrilateral from a saliency mask. A printed
 * box can look salient too, but the paper on both sides has similar brightness.
 */
export async function hasPaperBoundary(
  image: Sharp,
  sourceWidth: number,
  sourceHeight: number,
  corners: CornerPoint[],
): Promise<boolean> {
  if (corners.length !== 4) return false;
  const { data, info } = await image
    .rotate()
    .flatten({ background: 'white' })
    .resize({
      width: 800,
      height: 800,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const points = corners.map(({ x, y }) => ({
    x: (x * width) / sourceWidth,
    y: (y * height) / sourceHeight,
  }));
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / 4,
    y: points.reduce((sum, point) => sum + point.y, 0) / 4,
  };
  const near = Math.max(3, Math.min(width, height) * 0.012);
  const far = near * 2;

  function at(x: number, y: number): number | undefined {
    const column = Math.round(x);
    const row = Math.round(y);
    if (column >= 0 && column < width && row >= 0 && row < height)
      return data[row * width + column];
  }

  return points.every((start, index) => {
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < far * 4) return false;
    let nx = -dy / length;
    let ny = dx / length;
    if ((center.x - start.x) * nx + (center.y - start.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }

    let supported = 0;
    for (let sample = 1; sample <= 9; sample += 1) {
      const x = start.x + (dx * sample) / 10;
      const y = start.y + (dy * sample) / 10;
      const innerNear = at(x + nx * near, y + ny * near);
      const innerFar = at(x + nx * far, y + ny * far);
      const outerNear = at(x - nx * near, y - ny * near);
      const outerFar = at(x - nx * far, y - ny * far);
      if (
        innerNear !== undefined &&
        innerFar !== undefined &&
        outerNear !== undefined &&
        outerFar !== undefined &&
        Math.min(innerNear, innerFar) >= 135 &&
        Math.min(innerNear, innerFar) - Math.max(outerNear, outerFar) >= 24
      )
        supported += 1;
    }
    return supported >= 6;
  });
}

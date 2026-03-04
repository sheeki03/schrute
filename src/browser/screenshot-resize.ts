import { PNG } from 'pngjs';

// ─── Screenshot Resize ──────────────────────────────────────────
// Pure pixel buffer resize for vision API limits.
// No Playwright APIs, no DOM, no temp pages — just math on RGBA data.
// Uses area averaging (box filter) for fast, high-quality downscaling.

export interface ResizeOptions {
  maxDimension?: number;  // default 1568
  maxPixels?: number;     // default 1_150_000 (1.15MP)
}

export interface ResizeResult {
  buffer: Buffer;
  originalWidth: number;
  originalHeight: number;
  finalWidth: number;
  finalHeight: number;
  scaled: boolean;
}

export const DEFAULT_MAX_DIMENSION = 1568;
export const DEFAULT_MAX_PIXELS = 1_150_000;

/**
 * Compute the scale factor needed to fit within limits.
 * Returns >= 1 if no scaling needed.
 */
export function estimateScale(
  width: number,
  height: number,
  maxDimension: number,
  maxPixels: number,
): number {
  if (width <= 0 || height <= 0) return 1;

  let scale = 1;

  // Scale for max dimension
  if (width > maxDimension || height > maxDimension) {
    scale = Math.min(scale, maxDimension / Math.max(width, height));
  }

  // Scale for max total pixels
  const totalPixels = width * height;
  if (totalPixels > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / totalPixels));
  }

  return scale;
}

interface AxisMap {
  start: number;  // first source pixel index
  count: number;  // number of source pixels
  weights: Float64Array;
}

/**
 * Pre-compute source pixel ranges and fractional weights for one axis.
 * Eliminates per-pixel Math.floor/ceil/min/max from the hot loop.
 */
function buildAxisMap(srcLen: number, dstLen: number): AxisMap[] {
  const ratio = srcLen / dstLen;
  const map: AxisMap[] = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const srcStart = d * ratio;
    const srcEnd = (d + 1) * ratio;
    const s0 = Math.floor(srcStart);
    const s1 = Math.min(Math.ceil(srcEnd), srcLen);
    const count = s1 - s0;
    const weights = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      weights[i] = Math.min(s0 + i + 1, srcEnd) - Math.max(s0 + i, srcStart);
    }
    map[d] = { start: s0, count, weights };
  }
  return map;
}

/**
 * Downscale raw RGBA pixel data using area averaging (box filter).
 * Weight tables are pre-computed per axis so the inner loop is pure
 * multiply-accumulate with no branching or transcendental calls.
 */
function scaleImageAreaAverage(
  src: { data: Buffer | Uint8Array; width: number; height: number },
  dst: { width: number; height: number },
): { data: Buffer; width: number; height: number } {
  const outData = Buffer.alloc(dst.width * dst.height * 4);
  const xMap = buildAxisMap(src.width, dst.width);
  const yMap = buildAxisMap(src.height, dst.height);
  const srcData = src.data;
  const srcStride = src.width * 4;

  for (let dstY = 0; dstY < dst.height; dstY++) {
    const { start: sy0, count: yCount, weights: yW } = yMap[dstY];

    for (let dstX = 0; dstX < dst.width; dstX++) {
      const { start: sx0, count: xCount, weights: xW } = xMap[dstX];

      let r = 0, g = 0, b = 0, a = 0, totalWeight = 0;

      for (let yi = 0; yi < yCount; yi++) {
        const wy = yW[yi];
        const rowOff = (sy0 + yi) * srcStride;
        for (let xi = 0; xi < xCount; xi++) {
          const w = xW[xi] * wy;
          const idx = rowOff + (sx0 + xi) * 4;
          r += srcData[idx] * w;
          g += srcData[idx + 1] * w;
          b += srcData[idx + 2] * w;
          a += srcData[idx + 3] * w;
          totalWeight += w;
        }
      }

      const dstIdx = (dstY * dst.width + dstX) * 4;
      outData[dstIdx] = Math.round(r / totalWeight);
      outData[dstIdx + 1] = Math.round(g / totalWeight);
      outData[dstIdx + 2] = Math.round(b / totalWeight);
      outData[dstIdx + 3] = Math.round(a / totalWeight);
    }
  }

  return { data: outData, width: dst.width, height: dst.height };
}

/**
 * Resize a PNG buffer using pure pixel math (area averaging).
 * No external dependencies beyond pngjs, no Playwright API calls, no DOM.
 */
export function resizeScreenshotBuffer(
  buffer: Buffer,
  options?: ResizeOptions,
): ResizeResult {
  const maxDimension = options?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = options?.maxPixels ?? DEFAULT_MAX_PIXELS;

  // Decode PNG to raw RGBA pixels
  const png = PNG.sync.read(buffer);
  const { width, height } = png;

  // Check if within limits
  const scale = estimateScale(width, height, maxDimension, maxPixels);
  if (scale >= 1) {
    return {
      buffer,
      originalWidth: width,
      originalHeight: height,
      finalWidth: width,
      finalHeight: height,
      scaled: false,
    };
  }

  // Area-average downscale on raw RGBA data
  const scaledWidth = Math.max(1, Math.floor(width * scale));
  const scaledHeight = Math.max(1, Math.floor(height * scale));
  const scaled = scaleImageAreaAverage(
    { data: png.data, width, height },
    { width: scaledWidth, height: scaledHeight },
  );

  // Re-encode to PNG
  const out = new PNG({ width: scaledWidth, height: scaledHeight });
  scaled.data.copy(out.data);
  const resized = PNG.sync.write(out);

  return {
    buffer: resized,
    originalWidth: width,
    originalHeight: height,
    finalWidth: scaledWidth,
    finalHeight: scaledHeight,
    scaled: true,
  };
}

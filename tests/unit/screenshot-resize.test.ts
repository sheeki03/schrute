import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { estimateScale, resizeScreenshotBuffer } from '../../src/browser/screenshot-resize.js';

function createTestPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  // Fill with red pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      png.data[idx] = 255;     // R
      png.data[idx + 1] = 0;   // G
      png.data[idx + 2] = 0;   // B
      png.data[idx + 3] = 255; // A
    }
  }
  return PNG.sync.write(png);
}

describe('estimateScale', () => {
  it('returns 1 for images within limits', () => {
    expect(estimateScale(800, 600, 1568, 1_150_000)).toBe(1);
  });

  it('scales down for width exceeding max dimension', () => {
    const scale = estimateScale(3000, 1000, 1568, 10_000_000);
    expect(scale).toBeLessThan(1);
    expect(3000 * scale).toBeLessThanOrEqual(1568);
  });

  it('scales down for height exceeding max dimension', () => {
    const scale = estimateScale(1000, 3000, 1568, 10_000_000);
    expect(scale).toBeLessThan(1);
    expect(3000 * scale).toBeLessThanOrEqual(1568);
  });

  it('scales down for total pixels exceeding max', () => {
    const scale = estimateScale(2000, 2000, 5000, 1_000_000);
    expect(scale).toBeLessThan(1);
    expect(2000 * scale * 2000 * scale).toBeLessThanOrEqual(1_000_000);
  });

  it('returns 1 for zero dimensions', () => {
    expect(estimateScale(0, 0, 1568, 1_150_000)).toBe(1);
  });

  it('picks the more restrictive constraint', () => {
    // Both dimension and pixel count need scaling
    const scale = estimateScale(3000, 3000, 1568, 1_150_000);
    expect(scale).toBeLessThan(1);
    expect(3000 * scale).toBeLessThanOrEqual(1568);
    expect(3000 * scale * 3000 * scale).toBeLessThanOrEqual(1_150_000);
  });
});

describe('resizeScreenshotBuffer', () => {
  it('passes through under-limit images unchanged', () => {
    const original = createTestPng(100, 100);
    const result = resizeScreenshotBuffer(original);

    expect(result.scaled).toBe(false);
    expect(result.buffer).toBe(original); // same reference
    expect(result.originalWidth).toBe(100);
    expect(result.originalHeight).toBe(100);
    expect(result.finalWidth).toBe(100);
    expect(result.finalHeight).toBe(100);
  });

  it('resizes over-limit images', () => {
    const original = createTestPng(2000, 2000);
    const result = resizeScreenshotBuffer(original, {
      maxDimension: 500,
      maxPixels: 250_000,
    });

    expect(result.scaled).toBe(true);
    expect(result.finalWidth).toBeLessThanOrEqual(500);
    expect(result.finalHeight).toBeLessThanOrEqual(500);
    expect(result.originalWidth).toBe(2000);
    expect(result.originalHeight).toBe(2000);
  });

  it('produces valid PNG output', () => {
    const original = createTestPng(2000, 1000);
    const result = resizeScreenshotBuffer(original, { maxDimension: 500 });

    // Should be a valid PNG
    const decoded = PNG.sync.read(result.buffer);
    expect(decoded.width).toBe(result.finalWidth);
    expect(decoded.height).toBe(result.finalHeight);
  });

  it('uses default limits when no options provided', () => {
    // 1568 max dimension, 1.15M max pixels
    const small = createTestPng(800, 600);
    const result = resizeScreenshotBuffer(small);
    expect(result.scaled).toBe(false);
  });

  it('handles very small images', () => {
    const tiny = createTestPng(1, 1);
    const result = resizeScreenshotBuffer(tiny);
    expect(result.scaled).toBe(false);
    expect(result.finalWidth).toBe(1);
  });
});

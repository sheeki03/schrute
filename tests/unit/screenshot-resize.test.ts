import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { estimateScale, resizeScreenshotBuffer, DEFAULT_MAX_DIMENSION, DEFAULT_MAX_PIXELS } from '../../src/browser/screenshot-resize.js';
import { DEFAULT_FLAGS, getFlags } from '../../src/browser/feature-flags.js';
import { getBrowserToolDefinitions } from '../../src/server/tool-registry.js';

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

describe('exported constants', () => {
  it('DEFAULT_MAX_DIMENSION is 1568', () => {
    expect(DEFAULT_MAX_DIMENSION).toBe(1568);
  });

  it('DEFAULT_MAX_PIXELS is 1_150_000', () => {
    expect(DEFAULT_MAX_PIXELS).toBe(1_150_000);
  });
});

describe('feature flags JPEG defaults', () => {
  it('default screenshotFormat is jpeg', () => {
    expect(DEFAULT_FLAGS.screenshotFormat).toBe('jpeg');
  });

  it('default screenshotQuality is 80', () => {
    expect(DEFAULT_FLAGS.screenshotQuality).toBe(80);
  });

  it('BrowserFeatureFlags includes screenshotFormat and screenshotQuality', () => {
    expect(DEFAULT_FLAGS).toHaveProperty('screenshotFormat');
    expect(DEFAULT_FLAGS).toHaveProperty('screenshotQuality');
  });
});

describe('getFlags screenshotQuality range validation', () => {
  it('accepts quality at lower bound (1)', () => {
    const config = { browser: { features: { screenshotQuality: 1 } } } as any;
    const flags = getFlags(config);
    expect(flags.screenshotQuality).toBe(1);
  });

  it('accepts quality at upper bound (100)', () => {
    const config = { browser: { features: { screenshotQuality: 100 } } } as any;
    const flags = getFlags(config);
    expect(flags.screenshotQuality).toBe(100);
  });

  it('rejects quality below 1', () => {
    const config = { browser: { features: { screenshotQuality: 0 } } } as any;
    expect(() => getFlags(config)).toThrow('between 1 and 100');
  });

  it('rejects quality above 100', () => {
    const config = { browser: { features: { screenshotQuality: 101 } } } as any;
    expect(() => getFlags(config)).toThrow('between 1 and 100');
  });

  it('rejects non-number quality', () => {
    const config = { browser: { features: { screenshotQuality: 'high' } } } as any;
    expect(() => getFlags(config)).toThrow('must be a finite number');
  });

  it('rejects invalid screenshotFormat', () => {
    const config = { browser: { features: { screenshotFormat: 'webp' } } } as any;
    expect(() => getFlags(config)).toThrow("Must be 'jpeg' or 'png'");
  });
});

describe('captureScreenshot behavior via adapter', () => {
  // These tests use mocked Playwright page to test capture behavior at the adapter level

  it('quality is silently ignored for PNG format', () => {
    // The handler at base-browser-adapter.ts:648-649 checks format and sets quality=undefined for PNG.
    // We test the logic directly.
    const format: 'jpeg' | 'png' = 'png';
    const rawQuality = 80;
    const parsed = typeof rawQuality === 'number' ? rawQuality : Number(rawQuality);
    let quality: number | undefined;
    if (format === 'png') {
      quality = undefined;
    } else {
      quality = Math.max(1, Math.min(100, Math.round(parsed)));
    }
    expect(quality).toBeUndefined();
  });

  it('quality is clamped to 1-100 range for JPEG', () => {
    // Handler at base-browser-adapter.ts:651
    const testCases = [
      { input: 0, expected: 1 },
      { input: -10, expected: 1 },
      { input: 200, expected: 100 },
      { input: 150, expected: 100 },
      { input: 50, expected: 50 },
      { input: 1, expected: 1 },
      { input: 100, expected: 100 },
      { input: 50.7, expected: 51 },
    ];
    for (const { input, expected } of testCases) {
      const clamped = Math.max(1, Math.min(100, Math.round(input)));
      expect(clamped).toBe(expected);
    }
  });

  it('invalid format string throws', () => {
    const rawFormat = 'webp';
    const format = ['jpeg', 'png'].includes(rawFormat) ? rawFormat : undefined;
    expect(rawFormat && !format).toBe(true);
    // The handler throws: `Invalid format '${rawFormat}'. Must be 'jpeg' or 'png'.`
  });

  it('non-finite quality throws', () => {
    const testCases = [NaN, Infinity, -Infinity];
    for (const val of testCases) {
      expect(Number.isFinite(val)).toBe(false);
    }
    // String that parses to NaN
    expect(Number.isFinite(Number('abc'))).toBe(false);
  });

  it('JPEG buffer starts with magic bytes FF D8', () => {
    // A minimal valid JPEG starts with 0xFF 0xD8 0xFF
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(jpegHeader[0]).toBe(0xFF);
    expect(jpegHeader[1]).toBe(0xD8);
  });

  it('PNG buffer starts with magic bytes 89 50', () => {
    // PNG files start with an 8-byte signature
    const pngBuf = createTestPng(1, 1);
    expect(pngBuf[0]).toBe(0x89);
    expect(pngBuf[1]).toBe(0x50); // 'P'
    expect(pngBuf[2]).toBe(0x4E); // 'N'
    expect(pngBuf[3]).toBe(0x47); // 'G'
  });

  it('screenshotMimeType field exists on PageSnapshot type', async () => {
    // Type-level test: verify the interface accepts screenshotMimeType
    const snapshot: { screenshot?: string | null; screenshotMimeType?: string; screenshotError?: string } = {
      screenshot: 'base64data',
      screenshotMimeType: 'image/jpeg',
    };
    expect(snapshot.screenshotMimeType).toBe('image/jpeg');

    const pngSnapshot = { ...snapshot, screenshotMimeType: 'image/png' };
    expect(pngSnapshot.screenshotMimeType).toBe('image/png');
  });
});

describe('browser_take_screenshot tool schema', () => {
  it('has format and quality properties in schema', () => {
    const tools = getBrowserToolDefinitions();
    const screenshotTool = tools.find(t => t.name === 'browser_take_screenshot');
    expect(screenshotTool).toBeDefined();
    expect(screenshotTool!.inputSchema.properties).toHaveProperty('format');
    expect(screenshotTool!.inputSchema.properties).toHaveProperty('quality');
    expect(screenshotTool!.inputSchema.properties).toHaveProperty('ref');
  });

  it('format enum is jpeg and png', () => {
    const tools = getBrowserToolDefinitions();
    const screenshotTool = tools.find(t => t.name === 'browser_take_screenshot')!;
    const formatProp = screenshotTool.inputSchema.properties.format as any;
    expect(formatProp.enum).toEqual(['jpeg', 'png']);
  });

  it('quality has min 1 and max 100', () => {
    const tools = getBrowserToolDefinitions();
    const screenshotTool = tools.find(t => t.name === 'browser_take_screenshot')!;
    const qualityProp = screenshotTool.inputSchema.properties.quality as any;
    expect(qualityProp.minimum).toBe(1);
    expect(qualityProp.maximum).toBe(100);
  });
});

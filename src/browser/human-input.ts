/**
 * Hybrid cursor humanization — Bezier path generation + mouse preamble.
 * The preamble moves the cursor visually; actual clicking still uses Playwright locators.
 */
import type { Page } from 'playwright';

interface Point {
  x: number;
  y: number;
}

function generateBezierPath(start: Point, end: Point, steps = 15): Point[] {
  // Cubic Bezier with 2 random control points
  const cp1: Point = {
    x: start.x + (end.x - start.x) * 0.25 + (Math.random() - 0.5) * 100,
    y: start.y + (end.y - start.y) * 0.25 + (Math.random() - 0.5) * 100,
  };
  const cp2: Point = {
    x: start.x + (end.x - start.x) * 0.75 + (Math.random() - 0.5) * 100,
    y: start.y + (end.y - start.y) * 0.75 + (Math.random() - 0.5) * 100,
  };

  const path: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    path.push({
      x: u * u * u * start.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * end.x,
      y: u * u * u * start.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * end.y,
    });
  }
  return path;
}

export async function humanMousePreamble(page: Page, targetX: number, targetY: number): Promise<void> {
  // Get current mouse position (default 0,0 at session start)
  const start: Point = { x: 0, y: 0 };
  const end: Point = { x: targetX, y: targetY };
  const path = generateBezierPath(start, end);

  for (const point of path) {
    await page.mouse.move(point.x, point.y);
  }
}

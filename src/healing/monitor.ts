import type { SkillSpec, FailureCauseName } from '../skill/types.js';
import { INFRA_FAILURE_CAUSES } from '../skill/types.js';
import type { MetricsRepository, SkillMetric } from '../storage/metrics-repository.js';

// ─── Types ──────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degrading' | 'broken';

export interface HealthReport {
  skillId: string;
  status: HealthStatus;
  successRate: number;
  trend: number; // positive = improving, negative = degrading
  windowSize: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_WINDOW_SIZE = 50;
const MAX_WINDOW_HOURS = 24;
const SUDDEN_DROP_THRESHOLD = 0.3; // 30% drop
const DEGRADING_TREND_WINDOWS = 3;
const BROKEN_RATE_THRESHOLD = 0.3;
const HEALTHY_RATE_THRESHOLD = 0.7;

// ─── Monitor ────────────────────────────────────────────────────

/**
 * Analyze health of skills based on rolling success rate metrics.
 *
 * Rolling window: last 50 executions or 24 hours, whichever is less.
 * Detects:
 * - Sudden drops: success rate drops >30% in one window
 * - Gradual degradation: downward trend over 3+ windows
 * - Broken: success rate below 30%
 *
 * @param skills - Skills to monitor
 * @param metricsRepo - Repository for historical metrics
 * @returns Health reports for each skill
 */
export function monitorSkills(
  skills: SkillSpec[],
  metricsRepo: MetricsRepository,
): HealthReport[] {
  return skills.map((skill) => assessSkillHealth(skill, metricsRepo));
}

function filterOutInfraMetrics(metrics: SkillMetric[]): SkillMetric[] {
  return metrics.filter(m => !m.errorType || !INFRA_FAILURE_CAUSES.has(m.errorType as FailureCauseName));
}

function assessSkillHealth(
  skill: SkillSpec,
  metricsRepo: MetricsRepository,
): HealthReport {
  const metrics = metricsRepo.getRecentBySkillId(skill.id, MAX_WINDOW_SIZE * DEGRADING_TREND_WINDOWS);

  // Apply time window filter (24 hours), then strip infra failures before any classification.
  // Infra failures (policy_denied, rate_limited, budget_denied) are not skill observations
  // and must not influence health status, trend, or sudden-drop detection.
  const cutoff = Date.now() - MAX_WINDOW_HOURS * 60 * 60 * 1000;
  const recentMetrics = filterOutInfraMetrics(metrics.filter((m) => m.executedAt >= cutoff));

  if (recentMetrics.length === 0) {
    return {
      skillId: skill.id,
      status: 'healthy',
      successRate: skill.successRate,
      trend: 0,
      windowSize: 0,
    };
  }

  // Current window: last MAX_WINDOW_SIZE or all recent, whichever is less
  const currentWindow = recentMetrics.slice(0, MAX_WINDOW_SIZE);
  const windowSize = currentWindow.length;
  const successRate = computeSuccessRate(currentWindow);

  // Check for sudden drop (compare current vs previous window)
  const trend = computeTrend(recentMetrics);
  const hasSuddenDrop = detectSuddenDrop(recentMetrics);

  // Classify health status
  let status: HealthStatus;
  if (successRate < BROKEN_RATE_THRESHOLD || hasSuddenDrop) {
    status = 'broken';
  } else if (successRate < HEALTHY_RATE_THRESHOLD || trend < -0.1) {
    status = 'degrading';
  } else {
    status = 'healthy';
  }

  return { skillId: skill.id, status, successRate, trend, windowSize };
}

// ─── Helpers ────────────────────────────────────────────────────

function computeSuccessRate(metrics: SkillMetric[]): number {
  if (metrics.length === 0) return 0;
  const successes = metrics.filter((m) => m.success).length;
  return successes / metrics.length;
}

/**
 * Compute trend as the change in success rate between consecutive windows.
 * Positive = improving, negative = degrading.
 */
function computeTrend(metrics: SkillMetric[]): number {
  if (metrics.length < MAX_WINDOW_SIZE * 2) {
    // Not enough data for trend analysis
    return 0;
  }

  const windows: number[] = [];
  for (let i = 0; i < DEGRADING_TREND_WINDOWS; i++) {
    const start = i * MAX_WINDOW_SIZE;
    const end = start + MAX_WINDOW_SIZE;
    const windowMetrics = metrics.slice(start, end);
    if (windowMetrics.length === 0) break;
    windows.push(computeSuccessRate(windowMetrics));
  }

  if (windows.length < 2) return 0;

  // Trend = most recent window rate - oldest window rate
  // Note: metrics are sorted DESC, so windows[0] is most recent
  return windows[0] - windows[windows.length - 1];
}

/**
 * Detect a sudden drop: success rate dropped >30% between consecutive windows.
 */
function detectSuddenDrop(metrics: SkillMetric[]): boolean {
  if (metrics.length < MAX_WINDOW_SIZE * 2) return false;

  const currentRate = computeSuccessRate(metrics.slice(0, MAX_WINDOW_SIZE));
  const previousRate = computeSuccessRate(
    metrics.slice(MAX_WINDOW_SIZE, MAX_WINDOW_SIZE * 2),
  );

  return previousRate - currentRate > SUDDEN_DROP_THRESHOLD;
}

// ─── Nudge Decision ─────────────────────────────────────────────

/**
 * Determine if a skill should receive a "nudge" — a lightweight hint
 * to refine its behavior without full amendment/relearn.
 *
 * Nudge criteria: skill is healthy but success rate is between 70-90%
 * and trending slightly downward (< -0.05 but > -0.1).
 */
export function shouldNudge(report: HealthReport): boolean {
  if (report.status !== 'healthy') return false;
  if (report.windowSize < 10) return false; // Not enough data
  return report.successRate >= 0.7 && report.successRate < 0.9 && report.trend < -0.05;
}

// ─── Amendment Decision ─────────────────────────────────────────

/**
 * Determine whether a degrading/broken skill should attempt amendment,
 * skip (evaluation in progress), or fall through to relearning.
 */
export function shouldAmend(
  report: HealthReport,
  amendmentRepo: { hasActiveAmendment(skillId: string): boolean; isInCooldown(skillId: string, cooldown: number): boolean },
  cooldownExecutions: number = 50,
): 'amend' | 'skip' | 'relearn' {
  if (report.status !== 'degrading' && report.status !== 'broken') return 'skip';
  if (amendmentRepo.hasActiveAmendment(report.skillId)) return 'skip'; // evaluation in progress
  if (amendmentRepo.isInCooldown(report.skillId, cooldownExecutions)) return 'relearn'; // cooldown → fall through to relearner
  return 'amend';
}

import { createHash, randomUUID } from 'node:crypto';
import type { SkillSpec, WorkflowSpec, WorkflowStep } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

export interface WorkflowSuggestion {
  id: string;
  dedupKey: string;
  workflowSpec: WorkflowSpec;
  sourceChainSkillId?: string;
}

/**
 * Suggest workflows from skills that have chainSpec with detected dependency chains.
 * Only suggests when ALL steps are active, read-only, GET/HEAD.
 */
export function suggestWorkflows(skills: SkillSpec[]): WorkflowSuggestion[] {
  const skillById = new Map<string, SkillSpec>();
  for (const s of skills) skillById.set(s.id, s);

  const suggestions: WorkflowSuggestion[] = [];
  const dedupSet = new Set<string>();

  for (const skill of skills) {
    if (!skill.chainSpec || skill.chainSpec.steps.length < 2) continue;

    // Skip cookie-only chains — they produce non-executable param mappings
    // (cookie.sid → query param instead of Cookie header)
    if (skill.chainSpec.canReplayWithCookiesOnly) continue;

    const steps = skill.chainSpec.steps;
    const hasSourceStepIndex = steps.some(s =>
      s.extractsFrom.some(e => e.sourceStepIndex !== undefined),
    );

    // Legacy: only allow 2-step chains without sourceStepIndex
    if (!hasSourceStepIndex && steps.length > 2) continue;

    // Resolve all step refs to skills
    const resolvedSkills: SkillSpec[] = [];
    let allValid = true;
    for (const step of steps) {
      const resolved = skillById.get(step.skillRef);
      if (!resolved) { allValid = false; break; }
      resolvedSkills.push(resolved);
    }
    if (!allValid) continue;

    // All steps must be active, read-only, GET/HEAD
    const allEligible = resolvedSkills.every(s =>
      s.status === 'active' &&
      s.sideEffectClass === 'read-only' &&
      (s.method === 'GET' || s.method === 'HEAD'),
    );
    if (!allEligible) continue;

    // Build workflow steps with naming
    const nameCounter = new Map<string, number>();
    const workflowSteps: WorkflowStep[] = [];
    const stepNames: string[] = [];
    let invalidChain = false;

    for (let i = 0; i < steps.length; i++) {
      const chainStep = steps[i];
      const resolved = resolvedSkills[i];
      const baseName = resolved.name;

      // Unique step name: action name + index suffix
      const count = (nameCounter.get(baseName) ?? 0) + 1;
      nameCounter.set(baseName, count);
      const stepName = count > 1 ? `${baseName}_${count}` : baseName;
      stepNames.push(stepName);

      const wfStep: WorkflowStep = {
        skillId: resolved.id,
        name: stepName,
      };

      // Build paramMapping from extractions
      if (chainStep.extractsFrom.length > 0) {
        const paramMapping: Record<string, string> = {};
        for (const ext of chainStep.extractsFrom) {
          const targetPath = translatePath(ext.responsePath);
          let provenance: string;

          if (hasSourceStepIndex && ext.sourceStepIndex !== undefined) {
            // sourceStepIndex === previous step → $prev
            if (ext.sourceStepIndex === i - 1) {
              provenance = `$prev.${targetPath}`;
            } else if (ext.sourceStepIndex < i && ext.sourceStepIndex >= 0) {
              const sourceStepName = stepNames[ext.sourceStepIndex];
              if (!sourceStepName) {
                invalidChain = true;
                break;
              }
              provenance = `$steps.${sourceStepName}.${targetPath}`;
            } else {
              invalidChain = true;
              break;
            }
          } else {
            // Legacy: always $prev for 2-step chains
            provenance = `$prev.${targetPath}`;
          }

          const injectKey = ext.injectsInto.path;
          paramMapping[injectKey] = provenance;
        }
        if (invalidChain) break;
        wfStep.paramMapping = paramMapping;
      }

      workflowSteps.push(wfStep);
      if (invalidChain) break;
    }

    if (invalidChain) {
      log.debug({ skillId: skill.id }, 'Skipping workflow suggestion due to invalid sourceStepIndex provenance');
      continue;
    }

    // Dedup by ordered skillIds + paramMapping hash (order is semantic, NOT sorted)
    const dedupKey = computeDedupKey(workflowSteps);
    if (dedupSet.has(dedupKey)) continue;
    dedupSet.add(dedupKey);

    suggestions.push({
      id: randomUUID(),
      dedupKey,
      workflowSpec: { steps: workflowSteps },
      sourceChainSkillId: skill.id,
    });
  }

  if (suggestions.length > 0) {
    log.debug({ count: suggestions.length }, 'Workflow suggestions computed');
  }

  return suggestions;
}

/**
 * Translate response body paths to workflow data paths:
 * body.X → data.X, body[0].id → data[0].id, body → data, headers.X → headers.X
 */
function translatePath(responsePath: string): string {
  if (responsePath === 'body') return 'data';
  if (responsePath.startsWith('body.')) return 'data.' + responsePath.slice(5);
  if (responsePath.startsWith('body[')) return 'data[' + responsePath.slice(5);
  // headers.X stays as-is
  return responsePath;
}

/**
 * Dedup key: ordered skillIds + paramMapping hash.
 * Order is semantic (NOT sorted) — different orderings are distinct workflows.
 */
function computeDedupKey(steps: WorkflowStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    parts.push(step.skillId);
    if (step.paramMapping) {
      parts.push(JSON.stringify(step.paramMapping));
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

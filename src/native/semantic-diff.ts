/**
 * Semantic check — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { response: { status, headers, body }, skill: { id, validation, outputSchema? } }
 *   Output: { pass: boolean, details: string[] }
 */

import type { SemanticCheckResult } from '../replay/semantic-check.js';
import { checkSemantic as tsCheckSemantic } from '../replay/semantic-check.js';
import type { SkillSpec } from '../skill/types.js';
import { getNativeModule } from './index.js';

export function checkSemanticNative(
  response: { status: number; headers: Record<string, string>; body: string },
  skill: SkillSpec,
): SemanticCheckResult {
  const native = getNativeModule();

  if (native?.checkSemantic) {
    try {
      const input = JSON.stringify({
        response,
        skill: {
          id: skill.id,
          validation: skill.validation,
          outputSchema: skill.outputSchema,
        },
      });
      const resultJson: string = native.checkSemantic(input);
      return JSON.parse(resultJson) as SemanticCheckResult;
    } catch {
      // Fall through to TS fallback
    }
  }

  return tsCheckSemantic(response, skill);
}

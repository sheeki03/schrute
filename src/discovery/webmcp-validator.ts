import { getLogger } from '../core/logger.js';
import type { WebMcpTool } from './types.js';

const log = getLogger();

export interface ValidationWarning {
  field: string;
  message: string;
}

export function validateWebMcpTool(tool: WebMcpTool): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!tool.name || tool.name.length < 3) {
    warnings.push({ field: 'name', message: 'Tool name too short or missing' });
  }

  if (!tool.description || tool.description.length < 10) {
    warnings.push({ field: 'description', message: 'Missing or too-short description' });
  }

  if (tool.description?.toLowerCase().includes('do not')) {
    warnings.push({ field: 'description', message: 'Prefer positive instructions over negative limitations' });
  }

  if (tool.inputSchema?.properties) {
    for (const [key, prop] of Object.entries(tool.inputSchema.properties as Record<string, any>)) {
      if (!prop.type) {
        warnings.push({ field: `schema.${key}`, message: 'Missing type' });
      }
    }
  }

  return warnings;
}

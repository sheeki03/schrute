import { getLogger } from '../core/logger.js';

const log = getLogger();

export interface ScanResult {
  safe: boolean;
  findings: ScanFinding[];
}

export interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  detail: string;
  field: string;
}

// Dangerous patterns in skill templates
const PATTERNS: Array<{ re: RegExp; category: string; severity: ScanFinding['severity']; detail: string }> = [
  { re: /;\s*(DROP|DELETE|TRUNCATE|ALTER)\s/i, category: 'sql_injection', severity: 'critical', detail: 'SQL injection pattern in template' },
  { re: /<script[\s>]/i, category: 'xss', severity: 'critical', detail: 'Script tag in template' },
  { re: /javascript:/i, category: 'xss', severity: 'high', detail: 'JavaScript URI scheme' },
  { re: /\.\.\//g, category: 'path_traversal', severity: 'high', detail: 'Path traversal pattern' },
  { re: /\$\{.*\}/g, category: 'template_injection', severity: 'high', detail: 'Template literal injection' },
  { re: /eval\s*\(/i, category: 'code_injection', severity: 'critical', detail: 'eval() call in template' },
  { re: /Function\s*\(/i, category: 'code_injection', severity: 'critical', detail: 'Function() constructor' },
  { re: /import\s*\(/i, category: 'code_injection', severity: 'high', detail: 'Dynamic import()' },
  { re: /require\s*\(/i, category: 'code_injection', severity: 'high', detail: 'Dynamic require()' },
  { re: /__proto__|constructor\.prototype|Object\.assign/i, category: 'prototype_pollution', severity: 'high', detail: 'Prototype pollution pattern' },
  { re: /file:\/\//i, category: 'ssrf', severity: 'high', detail: 'File URI scheme (SSRF risk)' },
  { re: /169\.254\.169\.254|metadata\.google/i, category: 'ssrf', severity: 'critical', detail: 'Cloud metadata endpoint (SSRF)' },
  { re: /\b(password|secret|token|api_key|private_key)\b.*=\s*['"]/i, category: 'credential_exposure', severity: 'high', detail: 'Hardcoded credential pattern' },
];

export function scanSkill(skill: {
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredHeaders?: Record<string, string>;
  dynamicHeaders?: Record<string, string>;
  skillMd?: string;
}): ScanResult {
  const findings: ScanFinding[] = [];

  // Scan all text fields
  const fieldsToScan: Array<[string, string]> = [
    ['pathTemplate', skill.pathTemplate],
    ['inputSchema', JSON.stringify(skill.inputSchema)],
  ];
  if (skill.outputSchema) fieldsToScan.push(['outputSchema', JSON.stringify(skill.outputSchema)]);
  if (skill.requiredHeaders) fieldsToScan.push(['requiredHeaders', JSON.stringify(skill.requiredHeaders)]);
  if (skill.dynamicHeaders) fieldsToScan.push(['dynamicHeaders', JSON.stringify(skill.dynamicHeaders)]);
  if (skill.skillMd) fieldsToScan.push(['skillMd', skill.skillMd]);

  for (const [field, value] of fieldsToScan) {
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(value)) {
        findings.push({ severity: pattern.severity, category: pattern.category, detail: pattern.detail, field });
      }
    }
  }

  const safe = !findings.some(f => f.severity === 'critical' || f.severity === 'high');
  if (!safe) {
    log.warn({ findings: findings.length }, 'Security scanner found unsafe patterns');
  }

  return { safe, findings };
}

// ─── Types ──────────────────────────────────────────────────────

type DriftChangeType =
  | 'field_added'
  | 'field_removed'
  | 'type_changed'
  | 'value_changed';

interface DriftChange {
  path: string;
  type: DriftChangeType;
  /** Whether this change is breaking */
  breaking: boolean;
  /** Previous value description (for type changes) */
  previous?: string;
  /** Current value description (for type changes) */
  current?: string;
}

interface DriftResult {
  /** Whether any drift was detected */
  drifted: boolean;
  /** Whether any breaking changes were found */
  breaking: boolean;
  /** Individual changes detected */
  changes: DriftChange[];
}

// ─── Drift Detection ─────────────────────────────────────────────

/**
 * Detect schema drift between a stored JSON schema and a live response.
 *
 * Classifies changes as:
 * - **Breaking**: field removed, type changed — triggers version increment
 * - **Non-breaking**: field added — schema updated in place
 *
 * @param stored - Stored JSON Schema (from skill.outputSchema)
 * @param live - Live response data to check against the schema
 * @returns Drift result with individual changes
 */
export function detectDrift(
  stored: Record<string, unknown>,
  live: unknown,
): DriftResult {
  const changes: DriftChange[] = [];

  if (!stored || typeof stored !== 'object') {
    return { drifted: false, breaking: false, changes: [] };
  }

  if (live === null || live === undefined) {
    return { drifted: true, breaking: true, changes: [{ path: '$', type: 'type_changed', breaking: true, previous: 'object', current: 'null' }] };
  }

  // Extract expected properties from JSON Schema
  const storedProperties = extractSchemaProperties(stored);

  if (typeof live === 'object' && !Array.isArray(live)) {
    compareObject(storedProperties, live as Record<string, unknown>, '$', changes);
  } else if (Array.isArray(live) && stored.type === 'array') {
    // For arrays, check the first item against items schema
    const itemsSchema = stored.items as Record<string, unknown> | undefined;
    if (itemsSchema && live.length > 0) {
      const itemProperties = extractSchemaProperties(itemsSchema);
      if (typeof live[0] === 'object' && live[0] !== null) {
        compareObject(itemProperties, live[0] as Record<string, unknown>, '$[0]', changes);
      }
    }
  } else {
    // Type mismatch at root
    const expectedType = (stored.type as string) ?? 'object';
    const actualType = Array.isArray(live) ? 'array' : typeof live;
    if (expectedType !== actualType) {
      changes.push({
        path: '$',
        type: 'type_changed',
        breaking: true,
        previous: expectedType,
        current: actualType,
      });
    }
  }

  const hasBreaking = changes.some((c) => c.breaking);

  return {
    drifted: changes.length > 0,
    breaking: hasBreaking,
    changes,
  };
}

// ─── Internal ───────────────────────────────────────────────────

interface SchemaProperty {
  path: string;
  type: string;
  required: boolean;
}

function extractSchemaProperties(
  schema: Record<string, unknown>,
  prefix = '',
): SchemaProperty[] {
  const properties: SchemaProperty[] = [];
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((schema.required as string[]) ?? []);

  if (!props) return properties;

  for (const [key, propSchema] of Object.entries(props)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const type = (propSchema.type as string) ?? 'unknown';

    properties.push({
      path: fullPath,
      type,
      required: required.has(key),
    });

    // Recurse into nested objects
    if (type === 'object' && propSchema.properties) {
      properties.push(
        ...extractSchemaProperties(propSchema as Record<string, unknown>, fullPath),
      );
    }
  }

  return properties;
}

function compareObject(
  schemaProperties: SchemaProperty[],
  liveObj: Record<string, unknown>,
  prefix: string,
  changes: DriftChange[],
): void {
  const liveKeys = new Set(Object.keys(liveObj));

  // Check each expected property
  for (const prop of schemaProperties) {
    // Get the leaf key name
    const parts = prop.path.split('.');
    const leafKey = parts[parts.length - 1];

    // Only check top-level properties against liveObj (nested handled recursively)
    if (parts.length > 1) continue;

    const fullPath = prefix === '$' ? `$.${leafKey}` : `${prefix}.${leafKey}`;

    if (!liveKeys.has(leafKey)) {
      // Field removed — breaking
      changes.push({
        path: fullPath,
        type: 'field_removed',
        breaking: true,
      });
      continue;
    }

    // Check type match
    const liveValue = liveObj[leafKey];
    const liveType = getJsonType(liveValue);
    if (prop.type !== 'unknown' && liveType !== prop.type) {
      // Allow null for optional fields
      if (liveType === 'null' && !prop.required) {
        continue;
      }
      changes.push({
        path: fullPath,
        type: 'type_changed',
        breaking: true,
        previous: prop.type,
        current: liveType,
      });
    }

    liveKeys.delete(leafKey);
  }

  // Check for new fields not in schema
  // Only consider fields at the top level of schemaProperties
  const topLevelExpected = new Set(
    schemaProperties
      .filter((p) => !p.path.includes('.'))
      .map((p) => p.path),
  );

  for (const key of liveKeys) {
    if (!topLevelExpected.has(key)) {
      const fullPath = prefix === '$' ? `$.${key}` : `${prefix}.${key}`;
      changes.push({
        path: fullPath,
        type: 'field_added',
        breaking: false,
      });
    }
  }
}

function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

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
 * - **Breaking**: field removed (required), type changed — triggers version increment
 * - **Non-breaking**: field added, field removed (optional) — schema updated in place
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

  const storedType = (stored.type as string) ?? 'object';

  if (live === null || live === undefined) {
    return {
      drifted: true,
      breaking: true,
      changes: [{ path: '$', type: 'type_changed', breaking: true, previous: storedType, current: 'null' }],
    };
  }

  if (storedType === 'array' && Array.isArray(live)) {
    // For arrays, sample only the first item against items schema
    const itemsSchema = stored.items as Record<string, unknown> | undefined;
    if (itemsSchema && live.length > 0) {
      diffSchemaVsData(itemsSchema, live[0], '$[0]', changes);
    }
  } else if (storedType === 'object' && typeof live === 'object' && !Array.isArray(live)) {
    diffSchemaVsData(stored, live as Record<string, unknown>, '$', changes);
  } else {
    // Root type mismatch
    const actualType = Array.isArray(live) ? 'array' : typeof live;
    if (storedType !== actualType) {
      changes.push({
        path: '$',
        type: 'type_changed',
        breaking: true,
        previous: storedType,
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

function diffSchemaVsData(
  schema: Record<string, unknown>,
  data: unknown,
  path: string,
  changes: DriftChange[],
): void {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((schema.required as string[]) ?? []);

  if (!props) {
    // No properties defined — any data keys are "added"
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      for (const key of Object.keys(data as Record<string, unknown>)) {
        changes.push({
          path: `${path}.${key}`,
          type: 'field_added',
          breaking: false,
        });
      }
    }
    return;
  }

  const dataObj = (typeof data === 'object' && data !== null && !Array.isArray(data))
    ? data as Record<string, unknown>
    : null;
  const liveKeys = dataObj ? new Set(Object.keys(dataObj)) : new Set<string>();

  // Walk schema properties
  for (const [key, propSchema] of Object.entries(props)) {
    const fullPath = `${path}.${key}`;
    const expectedType = (propSchema.type as string) ?? 'unknown';
    const isRequired = required.has(key);

    if (!dataObj || !liveKeys.has(key)) {
      // Field removed
      changes.push({
        path: fullPath,
        type: 'field_removed',
        breaking: isRequired,
      });
      continue;
    }

    const liveValue = dataObj[key];
    const liveType = getJsonType(liveValue);

    // Allow null for optional fields
    if (liveType === 'null' && !isRequired) {
      liveKeys.delete(key);
      continue;
    }

    // Type check at this node
    if (expectedType !== 'unknown' && liveType !== expectedType) {
      changes.push({
        path: fullPath,
        type: 'type_changed',
        breaking: true,
        previous: expectedType,
        current: liveType,
      });
      liveKeys.delete(key);
      continue;
    }

    // Recurse into nested objects
    if (expectedType === 'object' && propSchema.properties) {
      diffSchemaVsData(propSchema as Record<string, unknown>, liveValue, fullPath, changes);
    }

    // Recurse into nested arrays — sample first item only
    if (expectedType === 'array' && propSchema.items && Array.isArray(liveValue) && liveValue.length > 0) {
      diffSchemaVsData(propSchema.items as Record<string, unknown>, liveValue[0], `${fullPath}[0]`, changes);
    }

    liveKeys.delete(key);
  }

  // Fields in live data but not in schema → field_added (non-breaking)
  for (const key of liveKeys) {
    changes.push({
      path: `${path}.${key}`,
      type: 'field_added',
      breaking: false,
    });
  }
}

function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

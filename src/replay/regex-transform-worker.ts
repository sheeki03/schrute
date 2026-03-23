import { parentPort, workerData } from 'node:worker_threads';

interface RegexWorkerData {
  input: string;
  expression: string;
  flags?: string;
}

function projectRegexMatch(match: RegExpExecArray): unknown {
  const namedCaptures = match.groups ? { ...match.groups } : undefined;
  if (namedCaptures && Object.keys(namedCaptures).length > 0) {
    const positionalCaptures = match.slice(1);
    if (positionalCaptures.length > Object.keys(namedCaptures).length) {
      return {
        ...namedCaptures,
        $captures: positionalCaptures,
      };
    }
    return namedCaptures;
  }

  if (match.length <= 1) {
    return match[0];
  }
  const captures = match.slice(1);
  return captures.length === 1 ? captures[0] : captures;
}

function runRegexTransform({ input, expression, flags }: RegexWorkerData): unknown {
  const regex = new RegExp(expression, flags);
  if (regex.global) {
    return Array.from(input.matchAll(regex)).map(projectRegexMatch);
  }

  const match = regex.exec(input);
  if (!match) {
    return undefined;
  }
  return projectRegexMatch(match);
}

try {
  const result = runRegexTransform(workerData as RegexWorkerData);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

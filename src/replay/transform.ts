import { Worker } from 'node:worker_threads';
import { JSONPath } from 'jsonpath-plus';
import { load } from 'cheerio';
import type { OutputTransform } from '../skill/types.js';

export interface AppliedTransformResult {
  data: unknown;
  rawData?: unknown;
  transformApplied: boolean;
  label?: string;
}

const VALID_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
const MAX_REGEX_EXPRESSION_LENGTH = 512;
const MAX_REGEX_INPUT_LENGTH = 100_000;
const REGEX_WORKER_TIMEOUT_MS = 2_000;
const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');

function projectRegexMatch(match) {
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

function runRegexTransform({ input, expression, flags }) {
  const regex = new RegExp(expression, flags);
  if (regex.global) {
    return Array.from(input.matchAll(regex)).map(projectRegexMatch);
  }

  const match = regex.exec(input);
  return match ? projectRegexMatch(match) : undefined;
}

try {
  parentPort.postMessage({ ok: true, result: runRegexTransform(workerData) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

interface RegexWorkerMessage {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function applyTransform(data: unknown, transform?: OutputTransform): Promise<AppliedTransformResult> {
  if (!transform) {
    return {
      data,
      transformApplied: false,
    };
  }

  let transformed: unknown;
  switch (transform.type) {
    case 'jsonpath':
      transformed = applyJsonPathTransform(data, transform.expression);
      break;
    case 'regex':
      transformed = await applyRegexTransform(data, transform.expression, transform.flags);
      break;
    case 'css':
      transformed = applyCssTransform(data, transform);
      break;
    default:
      transformed = data;
      break;
  }

  return {
    data: transformed,
    transformApplied: true,
    label: transform.label ?? defaultTransformLabel(transform),
  };
}

function applyJsonPathTransform(data: unknown, expression: string): unknown {
  const json = typeof data === 'string' ? tryParseJson(data) : data;
  return JSONPath({
    path: expression,
    json: (json ?? null) as string | number | boolean | object | unknown[] | null,
    wrap: false,
  });
}

async function applyRegexTransform(data: unknown, expression: string, flags?: string): Promise<unknown> {
  const input = stringifyForTextTransform(data);
  validateRegexTransform(expression, flags, input);
  return runRegexTransformWorker(input, expression, flags);
}

function validateRegexTransform(expression: string, flags: string | undefined, input: string): void {
  if (expression.length > MAX_REGEX_EXPRESSION_LENGTH) {
    throw new Error(`Regex transform expression exceeds ${MAX_REGEX_EXPRESSION_LENGTH} characters`);
  }
  if (input.length > MAX_REGEX_INPUT_LENGTH) {
    throw new Error(`Regex transform input exceeds ${MAX_REGEX_INPUT_LENGTH} characters`);
  }
  if (!flags) {
    return;
  }

  const seenFlags = new Set<string>();
  for (const flag of flags) {
    if (!VALID_REGEX_FLAGS.has(flag)) {
      throw new Error(`Invalid regex flag '${flag}'`);
    }
    if (seenFlags.has(flag)) {
      throw new Error(`Duplicate regex flag '${flag}'`);
    }
    seenFlags.add(flag);
  }
}

async function runRegexTransformWorker(input: string, expression: string, flags?: string): Promise<unknown> {
  try {
    return await runRegexInWorker(input, expression, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Worker bootstrap should be reliable, but keep a narrow fallback for runtime init failures.
    if (msg.includes('ERR_WORKER_PATH') || msg.includes('ERR_WORKER_INIT_FAILED')) {
      return runRegexInlineWithTimeout(input, expression, flags);
    }
    throw err;
  }
}

function runRegexInWorker(input: string, expression: string, flags?: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { input, expression, flags },
    });
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };

    const finish = (handler: (value: unknown) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    const onMessage = (message: RegexWorkerMessage): void => {
      void worker.terminate().catch(() => undefined);
      if (message.ok) {
        finish(resolve, message.result);
      } else {
        finish(reject, new Error(message.error ?? 'Regex transform failed'));
      }
    };

    const onError = (error: Error): void => {
      void worker.terminate().catch(() => undefined);
      finish(reject, error);
    };

    const onExit = (code: number): void => {
      if (!settled && code !== 0) {
        finish(reject, new Error(`Regex transform worker exited with code ${code}`));
      }
    };

    const timer = setTimeout(() => {
      void worker.terminate().catch(() => undefined);
      finish(reject, new Error(`Regex transform timed out after ${REGEX_WORKER_TIMEOUT_MS}ms`));
    }, REGEX_WORKER_TIMEOUT_MS);

    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

function runRegexInlineWithTimeout(input: string, expression: string, flags?: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Regex transform timed out after ${REGEX_WORKER_TIMEOUT_MS}ms`));
    }, REGEX_WORKER_TIMEOUT_MS);

    try {
      const regex = new RegExp(expression, flags);
      let result: unknown;
      if (regex.global) {
        result = Array.from(input.matchAll(regex)).map(projectRegexMatch);
      } else {
        const match = regex.exec(input);
        result = match ? projectRegexMatch(match) : undefined;
      }
      clearTimeout(timer);
      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
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

function applyCssTransform(
  data: unknown,
  transform: Extract<OutputTransform, { type: 'css' }>,
): unknown {
  const input = stringifyForTextTransform(data);
  const $ = load(input);
  const nodes = $(transform.selector);

  switch (transform.mode ?? 'text') {
    case 'html': {
      const first = nodes.first();
      return first.length > 0 ? first.html() ?? undefined : undefined;
    }
    case 'attr': {
      const first = nodes.first();
      return first.length > 0 ? first.attr(transform.attr ?? '') ?? undefined : undefined;
    }
    case 'list':
      if (transform.fields) {
        return nodes.toArray().map((node) => {
          const scope = $(node);
          const item: Record<string, unknown> = {};
          for (const [fieldName, field] of Object.entries(transform.fields ?? {})) {
            const target = scope.find(field.selector).first();
            item[fieldName] = extractCssValue(target, field.mode ?? 'text', field.attr);
          }
          return item;
        });
      }
      return nodes.toArray().map((node) => $(node).text().trim());
    case 'text':
    default: {
      const first = nodes.first();
      return first.length > 0 ? first.text().trim() : undefined;
    }
  }
}

function extractCssValue(
  node: ReturnType<ReturnType<typeof load>>,
  mode: 'text' | 'attr' | 'html',
  attr?: string,
): unknown {
  if (mode === 'attr') {
    return node.attr(attr ?? '') ?? undefined;
  }
  if (mode === 'html') {
    return node.html() ?? undefined;
  }
  return node.text().trim();
}

function defaultTransformLabel(transform: OutputTransform): string {
  switch (transform.type) {
    case 'jsonpath':
      return transform.expression;
    case 'regex':
      return transform.expression;
    case 'css':
      return transform.selector;
  }
}

function tryParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function stringifyForTextTransform(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data === undefined || data === null) {
    return '';
  }
  return JSON.stringify(data);
}

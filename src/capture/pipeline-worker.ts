import { isMainThread, parentPort } from 'node:worker_threads';
import type { AuthRecipe, ParameterEvidence, RequestChain } from '../skill/types.js';
import type { AuditableEntry } from './cdp-har-recorder.js';
import {
  extractRequestResponse,
  parseHar,
  type HarEntry,
  type StructuredRecord,
} from './har-extractor.js';
import { detectAuth } from './auth-detector.js';
import { discoverParamsNative as discoverParams } from '../native/param-discoverer.js';
import { detectChains } from './chain-detector.js';
import { canonicalizeRequest } from './canonicalizer.js';
import { isGraphQL } from './graphql-extractor.js';
import { filterRequests } from './noise-filter.js';

export interface PipelineAuditEntry extends AuditableEntry {
  startedDateTime: string;
}

export interface PipelineWorkerInput {
  records?: StructuredRecord[];
  auditEntries?: PipelineAuditEntry[];
  harPath?: string;
  siteId: string;
  inputs?: Record<string, string>;
}

export interface PipelineWorkerOutput {
  signalRecords: StructuredRecord[];
  restRecords: StructuredRecord[];
  gqlRecords: StructuredRecord[];
  authRecipe: AuthRecipe | null;
  paramEvidence: ParameterEvidence[];
  chains: RequestChain[];
  auditData: {
    totalCount: number;
    signalCount: number;
    noiseCount: number;
    dedupedCount: number;
  };
  auditEntries: PipelineAuditEntry[];
}

interface WorkerRequest {
  id: number;
  input: PipelineWorkerInput;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: PipelineWorkerOutput;
  error?: string;
}

export async function runPipelineTask(
  input: PipelineWorkerInput,
): Promise<PipelineWorkerOutput> {
  const { records, auditEntries } = loadPipelineInput(input);
  const filtered = filterEntriesWithRecords(auditEntries, records, input.siteId);
  const dedupedSignalRecords = deduplicateRecords(filtered.signalRecords);
  const restRecords = dedupedSignalRecords.filter(record => !isGraphQL(record.request));
  const gqlRecords = dedupedSignalRecords.filter(record => isGraphQL(record.request));

  const authRecipe = detectAuth(restRecords);
  const paramEvidence = discoverParams(restRecords.map(record => ({
    record,
    declaredInputs: input.inputs,
  })));
  const chains = detectChains(restRecords);
  const transportSignalRecords = dedupedSignalRecords.map(stripResponseBodiesForTransfer);
  const transportRestRecords = transportSignalRecords.filter(record => !isGraphQL(record.request));
  const transportGqlRecords = transportSignalRecords.filter(record => isGraphQL(record.request));

  return {
    signalRecords: transportSignalRecords,
    restRecords: transportRestRecords,
    gqlRecords: transportGqlRecords,
    authRecipe,
    paramEvidence,
    chains,
    auditData: {
      totalCount: auditEntries.length,
      signalCount: filtered.signalCount,
      noiseCount: filtered.noiseCount,
      dedupedCount: filtered.signalCount - dedupedSignalRecords.length,
    },
    auditEntries,
  };
}

function loadPipelineInput(input: PipelineWorkerInput): {
  records: StructuredRecord[];
  auditEntries: PipelineAuditEntry[];
} {
  if (input.records && input.auditEntries) {
    if (input.records.length !== input.auditEntries.length) {
      throw new Error('Pipeline worker invariant failed: records and auditEntries length mismatch');
    }
    return {
      records: input.records,
      auditEntries: input.auditEntries,
    };
  }

  if (input.harPath) {
    const harData = parseHar(input.harPath);
    const entries = harData.log.entries;
    return {
      records: entries.map(extractRequestResponse),
      auditEntries: entries as unknown as PipelineAuditEntry[],
    };
  }

  throw new Error('Pipeline worker requires either { records, auditEntries } or harPath');
}

function filterEntriesWithRecords(
  auditEntries: PipelineAuditEntry[],
  records: StructuredRecord[],
  siteId?: string,
): {
  signalRecords: StructuredRecord[];
  signalCount: number;
  noiseCount: number;
} {
  const { signal, noise } = filterRequests(auditEntries as unknown as HarEntry[], [], siteId);
  const signalSet = new Set(signal);
  const signalRecords: StructuredRecord[] = [];

  for (let index = 0; index < auditEntries.length; index++) {
    if (signalSet.has(auditEntries[index] as unknown as HarEntry)) {
      signalRecords.push(records[index]);
    }
  }

  return {
    signalRecords,
    signalCount: signal.length,
    noiseCount: noise.length,
  };
}

function deduplicateRecords(records: StructuredRecord[]): StructuredRecord[] {
  const seen = new Set<string>();
  return records.filter(record => {
    const canonical = canonicalizeRequest(record.request);
    const key = `${canonical.method}|${canonical.canonicalUrl}|${canonical.canonicalBody ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripResponseBodiesForTransfer(record: StructuredRecord): StructuredRecord {
  if (record.response.body === undefined) {
    return record;
  }

  return {
    ...record,
    response: {
      ...record.response,
      body: undefined,
    },
  };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

const workerPort = !isMainThread ? parentPort : null;

if (workerPort) {
  workerPort.on('message', (message: WorkerRequest) => {
    void runPipelineTask(message.input)
      .then((result) => {
        const response: WorkerResponse = {
          id: message.id,
          ok: true,
          result,
        };
        workerPort.postMessage(response);
      })
      .catch((err) => {
        const response: WorkerResponse = {
          id: message.id,
          ok: false,
          error: serializeError(err),
        };
        workerPort.postMessage(response);
      });
  });
}

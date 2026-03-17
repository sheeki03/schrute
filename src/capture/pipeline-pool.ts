import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../core/logger.js';
import {
  runPipelineTask,
  type PipelineWorkerInput,
  type PipelineWorkerOutput,
} from './pipeline-worker.js';

const log = getLogger();
const modulePath = fileURLToPath(import.meta.url);
const runningFromDist = modulePath.includes(`${sep}dist${sep}`);

interface PendingTask {
  resolve: (value: PipelineWorkerOutput) => void;
  reject: (reason?: unknown) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: PipelineWorkerOutput;
  error?: string;
}

export class PipelinePool {
  private worker: Worker | null = null;
  private nextTaskId = 1;
  private pending = new Map<number, PendingTask>();
  private queue = Promise.resolve();
  private shuttingDown = false;
  private readonly workerUrl = new URL('./pipeline-worker.js', import.meta.url);
  private readonly workerAvailable = runningFromDist && existsSync(fileURLToPath(this.workerUrl));

  async runPipeline(input: PipelineWorkerInput): Promise<PipelineWorkerOutput> {
    const runTask = async (): Promise<PipelineWorkerOutput> => {
      if (this.shuttingDown) {
        throw new Error('Pipeline pool is shutting down');
      }

      if (!this.workerAvailable) {
        return runPipelineTask(input);
      }

      const worker = this.ensureWorker();
      const taskId = this.nextTaskId++;

      return new Promise<PipelineWorkerOutput>((resolve, reject) => {
        this.pending.set(taskId, { resolve, reject });
        worker.postMessage({ id: taskId, input });
      });
    };

    const resultPromise = this.queue.then(runTask, runTask);
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    this.worker = null;

    for (const [, pending] of this.pending) {
      pending.reject(new Error('Pipeline pool terminated'));
    }
    this.pending.clear();

    if (worker) {
      await worker.terminate();
    }
  }

  async close(): Promise<void> {
    await this.destroy();
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(this.workerUrl, {
      // Strip inherited execArgv (--input-type, --inspect, etc.) that break ESM workers
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });

    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.ok && message.result) {
        pending.resolve(message.result);
        return;
      }

      pending.reject(new Error(message.error ?? 'Pipeline worker failed'));
    });

    worker.on('error', (err) => {
      log.warn({ err }, 'Pipeline worker crashed');
      this.failAllPending(err);
      this.worker = null;
    });

    worker.on('exit', (code) => {
      if (this.shuttingDown) {
        return;
      }
      if (code !== 0) {
        const err = new Error(`Pipeline worker exited with code ${code}`);
        log.warn({ code }, 'Pipeline worker exited unexpectedly');
        this.failAllPending(err);
      }
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private failAllPending(err: unknown): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

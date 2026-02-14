// Shared types used by both daemon server and daemon client.
// Canonical definitions live here to avoid duplication.

export interface PidFileContent {
  pid: number;
  version: string;
  apiVersion: number;
  startedAt: string;
}

export type TransportMode = 'uds' | 'tcp';

export interface TransportConfig {
  mode: TransportMode;
  socketPath?: string;
  port?: number;
  token?: string;
}

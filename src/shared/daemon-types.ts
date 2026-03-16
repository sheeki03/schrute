// Shared types used by both daemon server and daemon client.
// Canonical definitions live here to avoid duplication.

export interface PidFileContent {
  pid: number;
  version: string;
  apiVersion: number;
  startedAt: string;
}

export type TransportConfig =
  | { mode: 'uds'; socketPath: string; token?: string }
  | { mode: 'tcp'; port: number; token?: string };

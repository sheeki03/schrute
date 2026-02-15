// ─── Abstract LLM Interface ─────────────────────────────────────────
// Generic interface for optional LLM-assisted operations.
// Feature-gated: not required for core operation.

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_use';
}

export interface LlmProvider {
  readonly name: string;

  complete(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmResponse>;
}

// ─── OpenAI Adapter Stub ────────────────────────────────────────────
// Placeholder for OpenAI LLM integration. Not yet implemented.

import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmResponse,
} from '../interface.js';

export class OpenAiAdapter implements LlmProvider {
  readonly name = 'openai';

  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.model ?? 'gpt-4o';
  }

  async complete(
    _messages: LlmMessage[],
    _options?: LlmCompletionOptions,
  ): Promise<LlmResponse> {
    // TODO: Implement OpenAI API integration
    throw new Error(
      'OpenAI adapter not yet implemented. This is a stub for future LLM-assisted operations.',
    );
  }
}

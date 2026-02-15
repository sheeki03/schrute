// ─── Anthropic Adapter Stub ─────────────────────────────────────────
// Placeholder for Anthropic LLM integration. Not yet implemented.

import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmResponse,
} from '../interface.js';

export class AnthropicAdapter implements LlmProvider {
  readonly name = 'anthropic';

  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.model ?? 'claude-sonnet-4-5-20250929';
  }

  async complete(
    _messages: LlmMessage[],
    _options?: LlmCompletionOptions,
  ): Promise<LlmResponse> {
    // TODO: Implement Anthropic API integration
    throw new Error(
      'Anthropic adapter not yet implemented. This is a stub for future LLM-assisted operations.',
    );
  }
}

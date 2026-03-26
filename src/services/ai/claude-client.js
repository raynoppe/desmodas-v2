import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { AIAnalysisError } from '../../lib/errors.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 4096;

const RETRY_CONFIG = {
  network: { maxRetries: 3, baseDelay: 1000, backoffMultiplier: 2 },
  rate_limit: { maxRetries: 5, baseDelay: 5000, backoffMultiplier: 2 },
  api: { maxRetries: 2, baseDelay: 2000, backoffMultiplier: 1.5 },
  parse: { maxRetries: 2, baseDelay: 500, backoffMultiplier: 1 },
};

class ClaudeClient {
  constructor() {
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  async analyze(content, prompt, options = {}) {
    const { maxTokens = MAX_TOKENS, temperature = 0.1 } = options;

    return this._withRetry(async () => {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'user', content: `${prompt}\n\n---\n\n${content}` },
        ],
      });

      const text = response.content?.[0]?.text;
      if (!text) throw new AIAnalysisError('Empty response from Claude', 'analysis');

      return text;
    });
  }

  async analyzeJson(content, prompt, options = {}) {
    const text = await this.analyze(content, prompt, options);
    return this._parseJson(text);
  }

  _parseJson(text) {
    // Try direct parse
    try {
      return JSON.parse(text);
    } catch {}

    // Try extracting JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {}
    }

    // Try finding JSON object/array in text
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {}
    }

    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {}
    }

    throw new AIAnalysisError('Could not parse JSON from Claude response', 'parse');
  }

  async _withRetry(fn) {
    let lastError;
    const errorType = 'api';
    const retryConfig = RETRY_CONFIG[errorType];

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const type = this._categorizeError(error);
        const cfg = RETRY_CONFIG[type] || retryConfig;

        if (attempt >= cfg.maxRetries) break;

        const delay = this._calculateDelay(attempt, cfg);
        logger.warn({ attempt, delay, errorType: type, message: error.message }, 'Retrying Claude API call');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  _categorizeError(error) {
    const message = error.message?.toLowerCase() || '';
    const status = error.status;

    if (status === 429 || message.includes('rate limit')) return 'rate_limit';
    if (message.includes('network') || message.includes('econnreset') || message.includes('timeout')) return 'network';
    if (error.name === 'AIAnalysisError' && error.taskType === 'parse') return 'parse';
    return 'api';
  }

  _calculateDelay(attempt, config) {
    const baseDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt);
    const jitter = Math.random() * baseDelay * 0.2;
    return Math.min(baseDelay + jitter, 30000);
  }
}

export const claudeClient = new ClaudeClient();

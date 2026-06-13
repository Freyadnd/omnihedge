import Groq from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt';
import { HedgeAnalysisOutputSchema } from './schema';
import type { AgentInput, HedgeAnalysisOutput } from './types';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const MAX_TOKENS = 8192;
const MAX_RETRIES = 2;

export class HedgeAgent {
  private client: Groq;
  private model: string;

  constructor(apiKey?: string, model: string = DEFAULT_MODEL) {
    this.client = new Groq({ apiKey: apiKey ?? process.env.GROQ_API_KEY });
    this.model = model;
  }

  async analyze(input: AgentInput): Promise<HedgeAnalysisOutput> {
    this.validateInput(input);

    const userMessage = this.formatUserMessage(input);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        });

        const rawText = response.choices[0]?.message?.content ?? '';
        const parsed = this.extractJSON(rawText);
        return HedgeAnalysisOutputSchema.parse(parsed);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          console.warn(`[HedgeAgent] Attempt ${attempt} failed, retrying...`);
        }
      }
    }

    throw lastError;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private validateInput(input: AgentInput): void {
    if (!input.positions || !Array.isArray(input.positions)) {
      throw new Error('HedgeAgent: input.positions must be an array');
    }
    if (!input.events || !Array.isArray(input.events)) {
      throw new Error('HedgeAgent: input.events must be an array');
    }
    if (!input.news || !Array.isArray(input.news)) {
      throw new Error('HedgeAgent: input.news must be an array');
    }
  }

  private formatUserMessage(input: AgentInput): string {
    return `Analyze the following portfolio data and return your complete hedge analysis as a single raw JSON object. Begin your response with { and end with }.

## HyperEVM Portfolio Positions
${JSON.stringify(input.positions, null, 2)}

## Active Prediction Market Events
${JSON.stringify(input.events, null, 2)}

## Macro & Sector News Snapshot
${JSON.stringify(input.news, null, 2)}`;
  }

  private extractJSON(text: string): unknown {
    // Groq json_object mode should return clean JSON, but strip fences defensively
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `HedgeAgent: could not locate JSON object in response.\nPreview: ${stripped.slice(0, 300)}`
      );
    }

    return JSON.parse(stripped.slice(start, end + 1));
  }
}

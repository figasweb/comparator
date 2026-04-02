import Anthropic from '@anthropic-ai/sdk';
import type { ScrapingSource, ScrapingResult, ScrapingReport, ValidationRule } from '../types/index.js';

export interface ScraperConfig {
  /** Anthropic API key for LLM fallback */
  anthropicApiKey: string;
  /** Model to use for LLM fallback (default: claude-haiku-4-5-20251001) */
  model?: string;
  /** User-Agent for HTTP requests */
  userAgent?: string;
  /** Timeout in ms for HTTP requests (default: 15000) */
  timeout?: number;
  /** Callback for logging/notifications */
  onLog?: (message: string) => void;
}

/**
 * Scraping engine with regex extraction and LLM fallback.
 *
 * Strategy:
 * 1. Fetch HTML from source URL
 * 2. Try regex patterns to extract data
 * 3. Validate extracted data
 * 4. If validation fails → use LLM to extract data from HTML
 * 5. If LLM succeeds → ask LLM to generate improved regex for next time
 */
export class Scraper {
  private client: Anthropic;
  private config: Required<Pick<ScraperConfig, 'model' | 'userAgent' | 'timeout'>> & ScraperConfig;

  constructor(config: ScraperConfig) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.config = {
      model: 'claude-haiku-4-5-20251001',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      timeout: 15000,
      ...config,
    };
  }

  private log(msg: string) {
    this.config.onLog?.(msg);
  }

  /**
   * Scrape all sources and return a full report.
   */
  async scrapeAll(sources: ScrapingSource[]): Promise<ScrapingReport> {
    const results: ScrapingResult[] = [];

    for (const source of sources) {
      this.log(`Scraping ${source.nome} (${source.url})...`);
      const result = await this.scrapeOne(source);
      results.push(result);

      if (result.success) {
        this.log(`  OK: ${JSON.stringify(result.data)}`);
      } else {
        this.log(`  FAILED: ${result.errors?.join(', ')}`);
      }
    }

    const summary = {
      total: results.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      usedLlmFallback: results.filter(r => r.usedLlmFallback).length,
    };

    return {
      timestamp: new Date().toISOString(),
      results,
      summary,
    };
  }

  /**
   * Scrape a single source.
   */
  async scrapeOne(source: ScrapingSource): Promise<ScrapingResult> {
    // Step 1: Fetch HTML
    let html: string;
    try {
      html = await this.fetchHtml(source.url);
    } catch (err) {
      return {
        sourceId: source.id,
        success: false,
        errors: [`Failed to fetch ${source.url}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    // Step 2: Try regex extraction
    const regexResult = this.extractWithRegex(html, source.patterns);

    // Step 3: Validate
    const validationErrors = source.validation
      ? this.validate(regexResult.data, source.validation)
      : [];

    if (regexResult.allMatched && validationErrors.length === 0) {
      return {
        sourceId: source.id,
        success: true,
        data: regexResult.data,
      };
    }

    // Step 4: LLM fallback
    this.log(`  Regex failed for ${source.nome}: missing=[${regexResult.missing.join(',')}] validation=[${validationErrors.join(',')}]. Trying LLM...`);

    try {
      const llmResult = await this.extractWithLlm(html, source);

      const llmValidationErrors = source.validation
        ? this.validate(llmResult, source.validation)
        : [];

      if (llmValidationErrors.length > 0) {
        return {
          sourceId: source.id,
          success: false,
          data: llmResult,
          errors: [`LLM extraction failed validation: ${llmValidationErrors.join(', ')}`],
          usedLlmFallback: true,
        };
      }

      // Step 5: Ask LLM to fix regex patterns for next time
      let fixedPatterns: Record<string, string> | undefined;
      if (regexResult.missing.length > 0) {
        fixedPatterns = await this.fixRegexPatterns(html, source, regexResult.missing);
      }

      return {
        sourceId: source.id,
        success: true,
        data: llmResult,
        usedLlmFallback: true,
        fixedPatterns,
      };
    } catch (err) {
      return {
        sourceId: source.id,
        success: false,
        data: regexResult.data,
        errors: [
          `Regex: missing=[${regexResult.missing.join(',')}] validation=[${validationErrors.join(',')}]`,
          `LLM fallback error: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.config.userAgent },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractWithRegex(
    html: string,
    patterns: Record<string, RegExp>,
  ): { data: Record<string, unknown>; allMatched: boolean; missing: string[] } {
    const data: Record<string, unknown> = {};
    const missing: string[] = [];

    for (const [field, regex] of Object.entries(patterns)) {
      const match = html.match(regex);
      if (match && match[1] !== undefined) {
        const raw = match[1].trim();
        // Try to parse as number
        const num = parseFloat(raw.replace(',', '.').replace(/\s/g, ''));
        data[field] = isNaN(num) ? raw : num;
      } else {
        missing.push(field);
      }
    }

    return { data, allMatched: missing.length === 0, missing };
  }

  private validate(
    data: Record<string, unknown>,
    rules: Record<string, ValidationRule>,
  ): string[] {
    const errors: string[] = [];

    for (const [field, rule] of Object.entries(rules)) {
      const value = data[field];

      if (rule.required && (value === undefined || value === null)) {
        errors.push(`${field}: required but missing`);
        continue;
      }

      if (value === undefined || value === null) continue;

      if (rule.type === 'number' && typeof value !== 'number') {
        errors.push(`${field}: expected number, got ${typeof value}`);
        continue;
      }

      if (typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`${field}: ${value} < min(${rule.min})`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`${field}: ${value} > max(${rule.max})`);
        }
      }
    }

    return errors;
  }

  private async extractWithLlm(
    html: string,
    source: ScrapingSource,
  ): Promise<Record<string, unknown>> {
    const fields = Object.keys(source.patterns);

    // Truncate HTML to avoid token limits (keep first 30k chars)
    const truncatedHtml = html.length > 30000 ? html.substring(0, 30000) : html;

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Extract the following fields from the HTML below. This is from the website "${source.nome}" (${source.url}).

Fields to extract:
${fields.map(f => `- ${f}`).join('\n')}

Rules:
- Return ONLY valid JSON with the field names as keys
- Numbers should be numeric values (not strings)
- Percentages should be the number without the % sign (e.g., 5.5 not "5.5%")
- Currency values should be numbers without symbols (e.g., 75000 not "75.000€")
- If a field cannot be found, set it to null

HTML:
${truncatedHtml}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM response did not contain valid JSON');
    }

    return JSON.parse(jsonMatch[0]);
  }

  private async fixRegexPatterns(
    html: string,
    source: ScrapingSource,
    failedFields: string[],
  ): Promise<Record<string, string>> {
    // Find relevant HTML snippets around where data might be
    const truncatedHtml = html.length > 15000 ? html.substring(0, 15000) : html;

    const currentPatterns = failedFields.map(f => ({
      field: f,
      pattern: source.patterns[f]?.source || 'none',
    }));

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `The following regex patterns FAILED to extract data from "${source.nome}" (${source.url}).

Failed patterns:
${currentPatterns.map(p => `- ${p.field}: /${p.pattern}/`).join('\n')}

Write improved JavaScript regex patterns that would correctly extract these fields from the HTML below.
Return ONLY valid JSON where keys are field names and values are regex pattern strings (without / delimiters).
Each regex MUST have exactly one capture group for the value.

HTML snippet:
${truncatedHtml}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return {};
    }
  }
}

/**
 * Generic entity for comparison (bank, insurance, provider, etc.)
 */
export interface ComparatorEntity {
  id: string;
  nome: string;
  url: string;
  logo: string;
  [key: string]: unknown;
}

/**
 * Configuration for a scraping source
 */
export interface ScrapingSource {
  id: string;
  nome: string;
  url: string;
  /** Regex patterns to extract fields. Key = field name, Value = regex with capture group */
  patterns: Record<string, RegExp>;
  /** Validation rules for extracted values */
  validation?: Record<string, ValidationRule>;
}

export interface ValidationRule {
  min?: number;
  max?: number;
  type?: 'number' | 'string';
  required?: boolean;
}

export interface ScrapingResult {
  sourceId: string;
  success: boolean;
  data?: Record<string, unknown>;
  errors?: string[];
  /** Whether LLM fallback was used */
  usedLlmFallback?: boolean;
  /** If regex was fixed by LLM, the new pattern */
  fixedPatterns?: Record<string, string>;
}

export interface ScrapingReport {
  timestamp: string;
  results: ScrapingResult[];
  summary: {
    total: number;
    success: number;
    failed: number;
    usedLlmFallback: number;
  };
}

/**
 * Worker API environment bindings
 */
export interface ComparatorEnv {
  DATA_KV: KVNamespace;
  ALLOWED_ORIGINS?: string;
}

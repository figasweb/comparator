// Types
export type {
  ComparatorEntity,
  ScrapingSource,
  ScrapingResult,
  ScrapingReport,
  ValidationRule,
  ComparatorEnv,
} from './types/index.js';

// Worker
export { createWorkerHandler } from './worker/index.js';

// Scraper
export { Scraper } from './scraper/index.js';
export type { ScraperConfig, ExtractionFailureContext } from './scraper/index.js';

import type { ComparatorEnv } from '../types/index.js';

interface WorkerConfig {
  /** KV key where data is stored */
  kvKey?: string;
  /** Allowed CORS origins (comma-separated or "*") */
  allowedOrigins?: string;
  /** Cache TTL in seconds (default: 3600 = 1 hour) */
  cacheTtl?: number;
}

/**
 * Creates a Cloudflare Worker handler that serves comparison data from KV.
 *
 * Usage in your worker's index.ts:
 * ```ts
 * import { createWorkerHandler } from '@figasweb/comparator/worker';
 * export default createWorkerHandler({ kvKey: 'instituicoes' });
 * ```
 */
export function createWorkerHandler(config: WorkerConfig = {}) {
  const {
    kvKey = 'data',
    allowedOrigins = '*',
    cacheTtl = 3600,
  } = config;

  return {
    async fetch(request: Request, env: ComparatorEnv): Promise<Response> {
      const url = new URL(request.url);

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: corsHeaders(allowedOrigins, request),
        });
      }

      // Only GET allowed
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405, allowedOrigins, request);
      }

      // Health check
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok' }, 200, allowedOrigins, request);
      }

      // Main data endpoint
      if (url.pathname === '/api/data' || url.pathname === '/') {
        const category = url.searchParams.get('category');

        const raw = await env.DATA_KV.get(kvKey, 'text');
        if (!raw) {
          return jsonResponse({ error: 'No data available' }, 404, allowedOrigins, request);
        }

        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          return jsonResponse({ error: 'Corrupted data' }, 500, allowedOrigins, request);
        }

        // If category filter is requested and data is an object with categories
        if (category && typeof data === 'object' && data !== null && !Array.isArray(data)) {
          const categoryData = (data as Record<string, unknown>)[category];
          if (!categoryData) {
            return jsonResponse({ error: `Category '${category}' not found` }, 404, allowedOrigins, request);
          }
          data = categoryData;
        }

        return jsonResponse(data, 200, allowedOrigins, request, cacheTtl);
      }

      // Metadata endpoint (last update time, etc.)
      if (url.pathname === '/api/meta') {
        const meta = await env.DATA_KV.get(`${kvKey}:meta`, 'text');
        return jsonResponse(
          meta ? JSON.parse(meta) : { lastUpdate: null },
          200,
          allowedOrigins,
          request,
        );
      }

      return jsonResponse({ error: 'Not found' }, 404, allowedOrigins, request);
    },
  };
}

function corsHeaders(allowedOrigins: string, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins === '*'
    ? '*'
    : allowedOrigins.split(',').find(o => o.trim() === origin) || '';

  return {
    'Access-Control-Allow-Origin': allowed || allowedOrigins,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  allowedOrigins: string,
  request: Request,
  cacheTtl?: number,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders(allowedOrigins, request),
  };

  if (cacheTtl && status === 200) {
    headers['Cache-Control'] = `public, max-age=${cacheTtl}`;
  }

  return new Response(JSON.stringify(data), { status, headers });
}

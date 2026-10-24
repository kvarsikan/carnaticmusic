/**
 * Swaralayam — Cloudflare Worker reverse proxy for the Google Gemini API
 * ----------------------------------------------------------------------
 * Routes
 *   GET  /api/health      -> { ok, keyConfigured, model }   (used by "Test connection")
 *   POST /api/transcribe  -> forwards the JSON body to Gemini generateContent
 *   OPTIONS *             -> CORS preflight
 *
 * Environment (Worker -> Settings -> Variables and Secrets)
 *   GEMINI_API_KEY   (Secret, required)   your Google AI Studio key
 *   ALLOWED_ORIGINS  (Text, recommended)  e.g. https://yourname.github.io
 *                                         comma-separate several; omit or "*" = any origin
 *   GEMINI_MODEL     (Text, optional)     default below
 *
 * The request body is streamed straight through to Google (never parsed), so
 * large inline-audio payloads cost almost no CPU time on the free plan.
 */

// NOTE: gemini-1.5-flash was shut down by Google (Sept 2025). Override with the
// GEMINI_MODEL variable if you want a newer Flash model.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 20 * 1024 * 1024; // Gemini's inline request limit is ~20 MB
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // 1) CORS preflight
    if (request.method === 'OPTIONS') {
      return cors
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403 });
    }
    if (!cors) return jsonError('Origin not allowed.', 403);

    const model = resolveModel(env);

    // 2) Health check
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, keyConfigured: Boolean(env.GEMINI_API_KEY), model }, 200, cors);
    }

    // 3) Transcription proxy
    if (url.pathname === '/api/transcribe') {
      if (request.method !== 'POST') return jsonError('Use POST.', 405, cors);
      if (!env.GEMINI_API_KEY) return jsonError('GEMINI_API_KEY secret is not configured on the Worker.', 500, cors);

      const type = request.headers.get('Content-Type') || '';
      if (!type.includes('application/json')) return jsonError('Content-Type must be application/json.', 415, cors);

      const length = Number(request.headers.get('Content-Length'));
      if (!length) return jsonError('Content-Length header is required.', 411, cors);
      if (length > MAX_BODY_BYTES) return jsonError('Request too large (max 20 MB).', 413, cors);

      let upstream;
      try {
        upstream = await fetch(`${GEMINI_BASE}${model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY, // secret never leaves the Worker
          },
          body: request.body,
        });
      } catch (err) {
        return jsonError('Could not reach the Gemini API.', 502, cors);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    return jsonError('Not found.', 404, cors);
  },
};

function resolveModel(env) {
  const m = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  return /^[a-z0-9.\-]+$/i.test(m) ? m : DEFAULT_MODEL; // block path injection
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const any = list.includes('*');
  if (!any && !list.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': any ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(cors || {}) },
  });
}

function jsonError(message, status, cors) {
  return json({ error: { message } }, status, cors);
}

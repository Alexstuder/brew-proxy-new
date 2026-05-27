const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const dns = require('node:dns/promises');
const crypto = require('crypto');
const { searchShops } = require('./services/shopCrawler');

// ---------------------------------------------------------------------------
// Env helpers — treat empty / whitespace-only strings as "unset" so that
// docker-compose ${VAR:-} injection (empty string) falls back to in-code
// defaults rather than silently breaking URL construction or numeric logic.
// Same helpers as in db-sync.js (kept local to avoid a shared-util dependency).
// ---------------------------------------------------------------------------
function envStr(name, def) {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim() !== '') ? v : def;
}
function envNum(name, def) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const BASE_PATH = __dirname;
const LOCAL_ENV = process.env.PROXY_ENV ?? path.join(BASE_PATH, '.env');
const CACHE_DIR = path.join(BASE_PATH, 'cache');
const TELEMETRY_CACHE_FILE = path.join(CACHE_DIR, 'telemetry-cache.json');
const LAST_TELEMETRY_CACHE_FILE = path.join(CACHE_DIR, 'last-telemetry-cache.json');
const CONTROLLER_CACHE_FILE = path.join(CACHE_DIR, 'controllers-cache.json');
const LAST_CONTROLLER_CACHE_FILE = path.join(CACHE_DIR, 'last-controllers-cache.json');

loadEnvFile(LOCAL_ENV);
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Role validation — must run before any other env-reads that differ per role.
// PROXY_ROLE=assistent  →  OpenAI + Brewfather routes, against assistent-Supabase, no db-sync.
// PROXY_ROLE=rapt       →  RAPT routes + db-sync, against rapt-Supabase + db-rapt.
// ---------------------------------------------------------------------------
const PROXY_ROLE = process.env.PROXY_ROLE;
if (PROXY_ROLE !== 'assistent' && PROXY_ROLE !== 'rapt') {
  console.error(
    `PROXY_ROLE must be "assistent" or "rapt" (got: ${JSON.stringify(PROXY_ROLE)}). ` +
    'Set the PROXY_ROLE environment variable before starting.'
  );
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Innerhalb Docker erreicht der Proxy Supabase über das interne Kong (Container-Name).
// SUPABASE_PUBLIC_URL ist die Browser-URL (localhost / Cloudflare-Hostname) und wäre
// vom Container aus nicht auflösbar.
// envStr() ensures an empty-string injection from ${VAR:-} doesn't win over the next
// candidate or the final hardcoded default.
const SUPABASE_URL =
  envStr('SUPABASE_INTERNAL_URL', null) ??
  envStr('SUPABASE_PUBLIC_URL',   null) ??
  envStr('SUPABASE_URL',          null) ??
  'http://supabase-kong:8000';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BREWFATHER_BASE_URL = envStr('BREWFATHER_BASE_URL', 'https://api.brewfather.app/v2');
// RAPT_USERNAME/RAPT_API_KEY werden NICHT mehr aus env gelesen.
// Multi-User-Pattern: jeder User hat eigene RAPT-Creds in aibrewgenius.user_profiles,
// Proxy holt sie pro Request via Supabase-JWT (siehe requireRaptCreds).
const RAPT_TOKEN_ENDPOINT        = envStr('RAPT_TOKEN_ENDPOINT',      'https://id.rapt.io/connect/token');
const RAPT_API_BASE              = envStr('RAPT_API_BASE',            'https://api.rapt.io');
const RAPT_PROFILE_ENDPOINT      = envStr('RAPT_PROFILE_ENDPOINT',    '/api/Profiles/GetProfiles');
const RAPT_CONTROLLERS_ENDPOINT  = envStr('RAPT_CONTROLLER_ENDPOINT', '/api/TemperatureControllers/GetTemperatureControllers');
const RAPT_TELEMETRY_ENDPOINT    = envStr('RAPT_TELEMETRY_ENDPOINT',  '/api/Hydrometers/GetTelemetry');
const RAPT_CONTROLLER_USE        = envStr('RAPT_CONTROLLER_USE',      'Beer Fermentation');
const PORT                       = envNum('PORT',                     3000);
const CACHE_INTERVAL_MS          = envNum('RAPT_CACHE_INTERVAL_MS',   60 * 60 * 1000);
// CORS_ORIGIN: intentionally NOT defaulted via envStr — an empty string is a valid
// operator choice meaning "no fixed origin, fall back to '*' in setCorsHeaders".
// envStr would silently replace "" with '*', masking the operator intent.
const ALLOWED_ORIGIN_RAW = process.env.CORS_ORIGIN ?? '*';
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_RAW.split(',')
  .map(value => value.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.includes('*');

// Outbound fetch timeouts. Override via env; no var is required — these are safe defaults.
const OPENAI_FETCH_TIMEOUT_MS = envNum('OPENAI_FETCH_TIMEOUT_MS', 60000);
const RAPT_FETCH_TIMEOUT_MS   = envNum('RAPT_FETCH_TIMEOUT_MS',   15000);
const BF_FETCH_TIMEOUT_MS     = envNum('BF_FETCH_TIMEOUT_MS',     15000);
// Separate timeout for /api/proxy-image: proxying public image URLs, not RAPT-specific.
const IMAGE_FETCH_TIMEOUT_MS  = envNum('IMAGE_FETCH_TIMEOUT_MS',  15000);
// Timeout for the Supabase /auth/v1/user call inside requireAuthenticatedUser.
// Named independently from RAPT so auth latency can be tuned without affecting RAPT calls.
const AUTH_FETCH_TIMEOUT_MS   = envNum('AUTH_FETCH_TIMEOUT_MS',   15000);

// ---------------------------------------------------------------------------
// SSO Phase 5 — REST-Ticket-Konfiguration
// SSO_SIGNING_SECRET: HMAC-HS256-Secret, MUST be set in both proxy roles.
//   assistent-Proxy signiert Tickets damit; rapt-Proxy verifiziert sie.
// SSO_TICKET_TTL_SECS: Ticket-Laufzeit (Default 60, hartes Maximum 60).
// SSO_CLOCK_SKEW_SECS: erlaubter Clock-Skew bei iat-Zukunfts-Prüfung (Default 5).
// ---------------------------------------------------------------------------
const SSO_TICKET_TTL_SECS = Math.min(envNum('SSO_TICKET_TTL_SECS', 60), 60);
const SSO_CLOCK_SKEW_SECS = envNum('SSO_CLOCK_SKEW_SECS', 5);

// OPENAI_API_KEY is only required for the assistent role.
// The rapt proxy does not call OpenAI — crashing for a missing key there would be wrong.
if (PROXY_ROLE === 'assistent' && !OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Provide it via environment variable or proxy/.env file.');
  process.exit(1);
}

// SSO_SIGNING_SECRET must be present and at least 32 characters in both roles.
// A shorter secret weakens HMAC-HS256 to brute-force; abort at startup rather than
// silently issuing/accepting weak tickets.
const _ssoSigningSecretAtStartup = process.env.SSO_SIGNING_SECRET;
if (!_ssoSigningSecretAtStartup || _ssoSigningSecretAtStartup.length < 32) {
  console.error(
    '[SSO] SSO_SIGNING_SECRET is missing or too short (minimum 32 characters). ' +
    'Set a cryptographically random secret before starting.'
  );
  process.exit(1);
}

let telemetryCache = null;
let telemetryCacheTimestamp = 0;
let telemetryCachePromise = null;
let persistedRaptStartDate = null;
let lastEffectiveStartDate = null;
let controllersCache = null;
let lastControllersFetchTime = 0;
let lastHydrometersFetchTime = 0;
let cachedHydrometers = [];
// Per-User RAPT-Token-Cache. Key = Supabase user_id. Wert = {token, expiry}.
// Jeder Brewer hat sein eigenes RAPT-Konto -> eigener Token.
const raptTokenCacheByUser = new Map();

loadTelemetryCacheFromDisk();
loadControllersCacheFromDisk();

const server = http.createServer(async (req, res) => {
  try {
    console.log(`[Proxy] Incoming Request: ${req.method} ${req.url}`);
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'Proxy is running', version: '0.1.0', role: PROXY_ROLE }));
      return;
    }

    // -----------------------------------------------------------------------
    // Role-gated route dispatch.
    // Routes not registered for the active role fall through to the 404 below.
    // -----------------------------------------------------------------------

    if (PROXY_ROLE === 'assistent') {
      if (url.pathname === '/api/brew' && req.method === 'POST') {
        await handleBrewRequest(req, res);
        return;
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        await handleChatRequest(req, res);
        return;
      }
      if (url.pathname === '/api/picture' && req.method === 'POST') {
        await handleGenerateImageRequest(req, res);
        return;
      }
      if (url.pathname === '/api/proxy-image' && req.method === 'GET') {
        await handleProxyImageRequest(req, res);
        return;
      }
      // /api/shop-search intentionally has no JWT gate (existing behaviour —
      // noted for proxy-reviewer; not changed in this phase).
      if (url.pathname === '/api/shop-search' && req.method === 'POST') {
        await handleShopSearchRequest(req, res);
        return;
      }
      if (url.pathname.startsWith('/api/brewfather/')) {
        await handleBrewfatherProxyRequest(req, res, url);
        return;
      }
      // SSO Phase 5: Ticket-Issue (assistent only — rapt-Proxy hat diese Route NICHT)
      if (url.pathname === '/api/sso/rapt-ticket' && req.method === 'POST') {
        await handleSsoTicketRequest(req, res);
        return;
      }
    }

    if (PROXY_ROLE === 'rapt') {
      if (url.pathname === '/api/rapt/hydrometers' && req.method === 'GET') {
        await handleRaptHydrometersRequest(req, res);
        return;
      }
      if (url.pathname === '/api/rapt/hydrometer-telemetry' && req.method === 'GET') {
        await handleDirectHydrometerTelemetryRequest(req, res);
        return;
      }
      if (url.pathname === '/api/rapt/token' && req.method === 'POST') {
        await handleRaptTokenRequest(req, res);
        return;
      }
      if (url.pathname === '/api/rapt/profiles' && req.method === 'GET') {
        await handleRaptProfilesRequest(req, res);
        return;
      }
      if (url.pathname === '/api/rapt/telemetry' && req.method === 'GET') {
        await handleRaptTelemetryRequest(req, res);
        return;
      }
      if (url.pathname === '/api/rapt/telemetry/start-override') {
        await handleRaptStartOverrideRequest(req, res);
        return;
      }
      if (url.pathname === '/api/cache/telemetry' && req.method === 'GET') {
        await handleTelemetryCacheResponse(req, res);
        return;
      }
      if (url.pathname === '/api/cache/controllers' && req.method === 'GET') {
        await handleControllerCacheResponse(req, res);
        return;
      }
      // SSO Phase 5: Ticket-Redeem (rapt only — assistent-Proxy hat diese Route NICHT)
      // Auth-Gating: KEIN User-JWT (das Ticket ist der Auth-Beweis; begründeter Opt-out).
      if (url.pathname === '/api/sso/redeem' && req.method === 'POST') {
        await handleSsoRedeemRequest(req, res);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('[Proxy] Unhandled Request Error:', err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Internal Proxy Error',
          message: err.message,
          stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }));
      }
    } catch (innerErr) {
      console.error('[Proxy] Fatal error during error response:', innerErr);
    }
  }
});

const dbSync = require('./db-sync');

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT} (role=${PROXY_ROLE})`);
  if (PROXY_ROLE === 'rapt') {
    // Periodic sync RAPT API → Postgres (rapt.* schema).
    // Not started for the assistent role: no db-rapt connection, no RAPT creds there.
    dbSync.init();
  }
  // Hintergrund-Telemetry-Refresh deaktiviert seit Multi-User:
  // Es gibt keinen "system user" mehr, dessen Creds wir hätten — Refreshes
  // werden nun pro Foreground-Request des eingeloggten Users ausgelöst.
  // Disk-Cache wird nur noch von vorherigen User-Requests befüllt.
  // (Siehe project_auth_migration für Multi-User-Roadmap.)
});

function setCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin;
  const resolved =
    ALLOW_ALL_ORIGINS && requestOrigin
      ? requestOrigin
      : ALLOW_ALL_ORIGINS
        ? '*'
        : (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin))
          ? requestOrigin
          : ALLOWED_ORIGINS[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', resolved);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
}

async function handleChatRequest(req, res) {
  const authCtx = await requireAuthenticatedUser(req, res);
  if (!authCtx) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    const rawImage = data && typeof data === 'object' ? data.image : null;
    const imageBase64 =
      rawImage && typeof rawImage === 'object' && typeof rawImage.data === 'string'
        ? rawImage.data
        : null;
    const imageMime =
      rawImage && typeof rawImage === 'object' && typeof rawImage.mime_type === 'string'
        ? rawImage.mime_type
        : null;

    if (!prompt) {
      respondJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    const userContent = [{ type: 'text', text: prompt }];
    if (imageBase64 && imageMime) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${imageMime};base64,${imageBase64}` },
      });
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Du bist ein nützlicher Assistent für einen Braumeister. Antworte präzise auf seine Fragen oder Anweisungen.',
          },
          { role: 'user', content: userContent },
        ],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(OPENAI_FETCH_TIMEOUT_MS),
    });

    const payload = await openAiResponse.json();
    if (!openAiResponse.ok) {
      respondJson(res, openAiResponse.status, {
        error: payload?.error?.message || 'OpenAI API request failed.',
      });
      return;
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      respondJson(res, 502, { error: 'Antwort von OpenAI unvollständig.' });
      return;
    }

    respondJson(res, 200, { result: content.trim() });
  } catch (error) {
    console.error('Proxy error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'OpenAI request timed out.' });
      return;
    }
    respondJson(res, 500, { error: 'Interner Proxy-Fehler.' });
  }
}

async function handleGenerateImageRequest(req, res) {
  const authCtx = await requireAuthenticatedUser(req, res);
  if (!authCtx) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    const rawImage = data && typeof data === 'object' ? data.image : null;
    const imageBase64 =
      rawImage && typeof rawImage === 'object' && typeof rawImage.data === 'string'
        ? rawImage.data
        : null;
    const imageMime =
      rawImage && typeof rawImage === 'object' && typeof rawImage.mime_type === 'string'
        ? rawImage.mime_type
        : null;

    if (!prompt) {
      respondJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    // --- Step 1: Refine Prompt with GPT-4o ---
    // We want a perfect DALL-E prompt that describes a professional, atmospheric beer shot.
    const userContent = [
      {
        type: 'text',
        text: `Erstelle einen detaillierten, englischen DALL-E 3 Prompt basierend auf dieser Beschreibung: "${prompt}". 
               Das Ziel ist eine professionelle Produktfotografie eines Bieres. 
               Antworte NUR mit dem englischen Prompt für DALL-E.`,
      },
    ];

    if (imageBase64 && imageMime) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${imageMime};base64,${imageBase64}`,
        },
      });
      userContent[0].text += " Nutze das beigefügte Bild als visuelle Vorlage für Komposition, Glasform oder Atmosphäre, aber passe es an das beschriebene Bier an.";
    }

    const refineResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(OPENAI_FETCH_TIMEOUT_MS),
    });

    const refinePayload = await refineResponse.json();

    if (!refineResponse.ok) {
      // Log full upstream error server-side only; do not forward OpenAI error details to client.
      console.error('[Proxy] Prompt-Refinement OpenAI error:', refineResponse.status, refinePayload);
      respondJson(res, refineResponse.status, { error: 'Prompt-Refinement fehlgeschlagen.' });
      return;
    }

    const refinedPrompt = refinePayload.choices?.[0]?.message?.content?.trim();

    if (!refinedPrompt) {
      respondJson(res, 502, { error: 'Prompt-Refinement fehlgeschlagen.' });
      return;
    }

    // --- Step 2: Generate Image with gpt-image-1 ---
    // Liefert immer base64 (kein url-Mode). Wir verpacken in eine data: URI,
    // damit die Flutter-Seite das wie vorher als "URL" weiterverarbeiten kann.
    const imageResponse = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: refinedPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'medium',
      }),
      signal: AbortSignal.timeout(OPENAI_FETCH_TIMEOUT_MS),
    });

    const imagePayload = await imageResponse.json();

    if (!imageResponse.ok) {
      console.error('Image API error:', imageResponse.status, imagePayload);
      respondJson(res, imageResponse.status, {
        error: imagePayload?.error?.message || 'Bildgenerierung fehlgeschlagen.',
      });
      return;
    }

    const b64 = imagePayload.data?.[0]?.b64_json;
    if (!b64) {
      respondJson(res, 502, { error: 'Kein Bild von gpt-image-1 erhalten.' });
      return;
    }

    respondJson(res, 200, { result: `data:image/png;base64,${b64}` });
  } catch (error) {
    console.error('Proxy error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'OpenAI request timed out.' });
      return;
    }
    respondJson(res, 500, { error: 'Interner Proxy-Fehler.' });
  }
}

async function handleProxyImageRequest(req, res) {
  try {
    const urlParts = new URL(req.url, `http://${req.headers.host}`);
    const imageUrl = urlParts.searchParams.get('url');

    if (!imageUrl) {
      respondJson(res, 400, { error: 'URL is required.' });
      return;
    }

    // SSRF guard: only allow public https URLs; reject loopback, private ranges,
    // link-local (including cloud-metadata 169.254.169.254), and non-https schemes.
    const safe = await isSafePublicHttpsUrl(imageUrl);
    if (!safe) {
      respondJson(res, 400, { error: 'Ungültige Bild-URL' });
      return;
    }

    const imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });

    if (!imageResponse.ok) {
      respondJson(res, imageResponse.status, { error: 'Failed to fetch image from source.' });
      return;
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/png';
    res.writeHead(200, {
      'Content-Type': contentType,
      // Intentional wildcard: this route serves public AI-generated image blobs for use
      // in <img src> / img-src contexts from any origin. The SSRF guard above ensures the
      // source URL is a safe public HTTPS resource, so '*' here is deliberate and correct.
      // The top-level setCorsHeaders call already ran with the configured CORS_ORIGIN; we
      // override it here because img-src does not benefit from credential-scoped CORS.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });

    const arrayBuffer = await imageResponse.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));

  } catch (error) {
    console.error('Proxy image error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'Image fetch timed out.' });
      return;
    }
    respondJson(res, 500, { error: 'Interner Proxy-Fehler beim Laden des Bildes.' });
  }
}

async function handleBrewRequest(req, res) {
  const authCtx = await requireAuthenticatedUser(req, res);
  if (!authCtx) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    const rawImage = data && typeof data === 'object' ? data.image : null;
    const imageBase64 =
      rawImage && typeof rawImage === 'object' && typeof rawImage.data === 'string'
        ? rawImage.data
        : null;
    const imageMime =
      rawImage && typeof rawImage === 'object' && typeof rawImage.mime_type === 'string'
        ? rawImage.mime_type
        : null;

    if (!prompt) {
      respondJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    const userContent = [{ type: 'text', text: prompt }];
    if (imageBase64 && imageMime) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${imageMime};base64,${imageBase64}` },
      });
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: "Du bist ein professioneller Brau-Assistent. Befolge strikt die Anweisungen im User-Prompt zur Erstellung detaillierter Bierrezepte inklusive aller Prozessschritte.",
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(OPENAI_FETCH_TIMEOUT_MS),
    });

    const payload = await openAiResponse.json();

    if (!openAiResponse.ok) {
      console.error('OpenAI API error:', openAiResponse.status, payload);
      respondJson(res, openAiResponse.status, {
        error: payload?.error?.message || 'OpenAI API request failed.',
      });
      return;
    }

    const content = extractResponseText(payload);

    if (!content) {
      console.error('OpenAI empty content payload:', payload);
      respondJson(res, 502, { error: 'Antwort von OpenAI unvollständig.' });
      return;
    }

    respondJson(res, 200, { result: content.trim() });
  } catch (error) {
    console.error('Proxy error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'OpenAI request timed out.' });
      return;
    }
    respondJson(res, 500, { error: 'Interner Proxy-Fehler.' });
  }
}

async function handleShopSearchRequest(req, res) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const query = typeof data.query === 'string' ? data.query.trim() : '';
    if (!query) {
      respondJson(res, 400, { error: 'query is required.' });
      return;
    }

    const results = await searchShops(query);
    respondJson(res, 200, { query, shops: results });
  } catch (error) {
    console.error('Shop search error:', error);
    respondJson(res, 500, {
      error: error.message || 'Konnte Shopsuche nicht ausführen.',
    });
  }
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  // Standard Chat Completions Format
  if (payload.choices && payload.choices[0] && payload.choices[0].message) {
    return payload.choices[0].message.content || '';
  }

  const textParts = [];
  const outputs = Array.isArray(payload.output) ? payload.output : [];
  outputs.forEach(item => {
    if (!item) return;
    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach(block => {
        if (block?.type === 'output_text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      });
    } else if (typeof item.text === 'string') {
      textParts.push(item.text);
    }
  });
  if (textParts.length === 0) {
    const fallback = payload.output_text;
    if (typeof fallback === 'string') {
      textParts.push(fallback);
    } else if (Array.isArray(fallback)) {
      fallback.forEach(entry => {
        if (typeof entry === 'string') {
          textParts.push(entry);
        }
      });
    }
  }
  return textParts.join('\n').trim();
}

async function handleRaptTokenRequest(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  try {
    const tokenData = await requestRaptTokenForUser(ctx);
    respondJson(res, 200, tokenData);
  } catch (error) {
    console.error('RAPT token error:', error);
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT token request failed.' });
  }
}

async function handleRaptProfilesRequest(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  try {
    const token = await requestRaptTokenForUser(ctx);
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');
    const apiResponse = await fetch(`${base}${RAPT_PROFILE_ENDPOINT}`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
    });
    const payload = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }
    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT devices error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'RAPT request timed out.' });
      return;
    }
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT devices request failed.' });
  }
}

async function handleRaptHydrometersRequest(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  try {
    const token = await requestRaptTokenForUser(ctx);
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');
    const apiResponse = await fetch(`${base}/api/Hydrometers/GetHydrometers`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
    });
    const payload = await apiResponse.json().catch(() => []);
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }
    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT hydrometers error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'RAPT request timed out.' });
      return;
    }
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT hydrometers request failed.' });
  }
}

async function handleDirectHydrometerTelemetryRequest(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hydrometerId = url.searchParams.get('hydrometerId');
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');

    if (!hydrometerId || !startDate || !endDate) {
      respondJson(res, 400, { error: 'Missing parameters: hydrometerId, startDate, endDate' });
      return;
    }

    const token = await requestRaptTokenForUser(ctx);
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');
    const teleUrl = new URL(`${base}/api/Hydrometers/GetTelemetry`);
    teleUrl.searchParams.set('hydrometerId', hydrometerId);
    teleUrl.searchParams.set('startDate', startDate);
    teleUrl.searchParams.set('endDate', endDate);

    const apiResponse = await fetch(teleUrl, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
    });
    const payload = await apiResponse.json().catch(() => []);
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }
    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT direct telemetry error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'RAPT request timed out.' });
      return;
    }
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT telemetry request failed.' });
  }
}

async function handleRaptTelemetryRequest(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const forceReload = ['1', 'true'].includes((url.searchParams.get('reload') || '').toLowerCase());
    const startOverrideRaw = url.searchParams.get('start') || url.searchParams.get('startDate');
    const startOverride = normalizeStartDateParam(startOverrideRaw);
    if (startOverrideRaw && !startOverride) {
      respondJson(res, 400, { error: 'Ungültiges Startdatum.' });
      return;
    }
    if (startOverride) {
      persistedRaptStartDate = startOverride;
    }
    const effectiveStartOverride = startOverride || persistedRaptStartDate || null;
    const requestedKey = effectiveStartOverride || null;
    const canServeCached =
      !forceReload &&
      telemetryCache &&
      telemetryCache.requestedStartDate === requestedKey;
    const data = canServeCached
      ? telemetryCache
      : await ensureTelemetryCache({
        force: forceReload,
        startDateOverride: effectiveStartOverride,
        userCtx: ctx,
      });
    let payloadData = data;
    const isLiveRequest = !effectiveStartOverride;

    if (isLiveRequest && !hasActiveSessionInCache()) {
      const fallback = await tryServeFallback();
      if (fallback) {
        payloadData = fallback;
      }
    }

    const payload = {
      ...payloadData,
      persistedStartDate: persistedRaptStartDate,
      resolvedStartDate: (effectiveStartOverride || (payloadData && payloadData.startDate)) || null,
    };

    console.log(`[Proxy] Final Response Rows: ${payload.rows ? payload.rows.length : 0}`);
    if (payload.rows && payload.rows.length > 0 && payload.rows[0].error) {
      console.log(`[Proxy] First Row Error: ${payload.rows[0].error}`);
    }

    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT telemetry error:', error);
    if (isTimeoutError(error)) {
      respondJson(res, 504, { error: 'RAPT request timed out.' });
      return;
    }
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT telemetry request failed.' });
  }
}

async function handleTelemetryCacheResponse(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;

  let dataToSend = telemetryCache;

  if (!dataToSend) {
    try {
      await ensureTelemetryCache({ force: false, userCtx: ctx });
      dataToSend = telemetryCache;
    } catch (error) {
      console.warn('Unable to refresh telemetry cache:', error.message || error);
    }
  }

  // Fallback Logic for Cache Endpoint
  if (!hasActiveSessionInCache()) {
    const fallback = await tryServeFallback();
    if (fallback) {
      console.log('[Proxy] Using fallback for cache endpoint.');
      dataToSend = fallback;
    }
  }

  if (!dataToSend) {
    respondJson(res, 404, { error: 'Telemetry cache unavailable.' });
    return;
  }
  respondJson(res, 200, dataToSend);
}

async function tryServeFallback() {
  const fromDisk = tryServeFallbackFromDisk();
  if (fromDisk) return fromDisk;
  return tryServeFallbackFromDb();
}

function tryServeFallbackFromDisk() {
  try {
    if (fs.existsSync(LAST_TELEMETRY_CACHE_FILE)) {
      const raw = fs.readFileSync(LAST_TELEMETRY_CACHE_FILE, 'utf8');
      const diskData = JSON.parse(raw);
      const potentialPayload = diskData.payload || diskData;

      if (potentialPayload && Array.isArray(potentialPayload.rows) && potentialPayload.rows.length) {
        // Check if rows are actually valid (no error)
        if (!potentialPayload.rows[0].error) {
          console.log(`[Proxy] Serving disk fallback with ${potentialPayload.rows.length} rows.`);
          return { ...potentialPayload, isFallback: true };
        }
      }
    }
  } catch (err) {
    console.warn('[Proxy] Disk fallback read failed:', err.message);
  }
  return null;
}

// Fallback aus rapt.* DB-Tabellen: liefert Hydrometer-Telemetrie des
// letzten brew_session-Zeitfensters, gemappt auf die übliche row-Shape.
async function tryServeFallbackFromDb() {
  const pool = dbSync.getPool && dbSync.getPool();
  if (!pool) return null;

  try {
    const sessionRes = await pool.query(`
      SELECT bs.profile_id, bs.name, bs.start_date, bs.end_date
      FROM rapt.brew_sessions bs
      WHERE bs.start_date IS NOT NULL AND bs.end_date IS NOT NULL
      ORDER BY bs.end_date DESC
      LIMIT 1
    `);
    if (sessionRes.rows.length === 0) return null;
    const session = sessionRes.rows[0];

    const teleRes = await pool.query(`
      SELECT h.hydrometer_id, h.created_on, h.temperature, h.gravity,
             h.gravity_velocity, h.battery, h.mac_address
      FROM rapt.telemetry_hydrometers h
      WHERE h.created_on BETWEEN $1 AND $2
      ORDER BY h.created_on ASC
    `, [session.start_date, session.end_date]);

    if (teleRes.rows.length === 0) return null;

    const ctrlRes = await pool.query(`
      SELECT DISTINCT device_id FROM rapt.telemetry_controllers
      WHERE profile_id = $1 LIMIT 1
    `, [session.profile_id]);
    const controllerId = ctrlRes.rows[0]?.device_id || null;

    const startIso = new Date(session.start_date).toISOString();
    const rows = teleRes.rows.map(r => ({
      controllerId,
      hydrometerId: r.hydrometer_id,
      startDate: startIso,
      createdOn: new Date(r.created_on).toISOString(),
      temperature: r.temperature,
      gravity: r.gravity,
      gravityVelocity: r.gravity_velocity,
      battery: r.battery,
      macAddress: r.mac_address,
      profileName: session.name,
    }));

    console.log(`[Proxy] Serving DB fallback: session "${session.name}" with ${rows.length} rows.`);
    return {
      rows,
      generatedAt: new Date().toISOString(),
      startDate: startIso,
      endDate: new Date(session.end_date).toISOString(),
      profileName: session.name,
      requestedStartDate: null,
      isFallback: true,
    };
  } catch (err) {
    console.warn('[Proxy] DB fallback failed:', err.message);
    return null;
  }
}

async function handleControllerCacheResponse(req, res) {
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;

  let dataToSend = controllersCache;

  if (!dataToSend) {
    try {
      await ensureTelemetryCache({ force: false, userCtx: ctx });
      dataToSend = controllersCache;
    } catch (error) {
      console.warn('Unable to refresh controller cache:', error.message || error);
    }
  }

  // Fallback Logic for Controllers
  if (!dataToSend && isFallbackModeOrNoActiveSession()) {
    try {
      if (fs.existsSync(LAST_CONTROLLER_CACHE_FILE)) {
        const raw = fs.readFileSync(LAST_CONTROLLER_CACHE_FILE, 'utf8');
        const diskData = JSON.parse(raw);
        // Ensure correct structure
        const potentialControllers = diskData.controllers || diskData;
        if (Array.isArray(potentialControllers)) {
          console.log(`[Proxy] Serving fallback controllers (${potentialControllers.length}).`);
          dataToSend = { controllers: potentialControllers, isFallback: true };
        }
      }
    } catch (err) {
      console.warn('[Proxy] Controller fallback failed:', err.message);
    }
  }

  if (!dataToSend) {
    respondJson(res, 404, { error: 'Controller cache unavailable.' });
    return;
  }
  respondJson(res, 200, dataToSend);
}

function isFallbackModeOrNoActiveSession() {
  return !hasActiveSessionInCache();
}

async function handleRaptStartOverrideRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  // Auth-Gate: konsistent mit allen anderen /api/rapt/*-Routen. Vorher fehlte der
  // Check komplett (GET/POST/DELETE liefen unauthentifiziert mit 200) — jeder konnte
  // den globalen persistedRaptStartDate-State ändern. requireRaptCreds sendet bei
  // fehlendem/ungültigem JWT 401 bzw. bei fehlenden RAPT-Creds 400 und gibt null zurück.
  const ctx = await requireRaptCreds(req, res);
  if (!ctx) return;
  if (req.method === 'GET') {
    respondJson(res, 200, { startDate: persistedRaptStartDate });
    return;
  }
  if (req.method === 'DELETE') {
    persistedRaptStartDate = null;
    resetTelemetryCache();
    respondJson(res, 200, { startDate: null });
    return;
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body || '{}');
      const normalized = normalizeStartDateParam(
        data?.startDate || data?.start || data?.value || data?.date,
      );
      if (!normalized) {
        respondJson(res, 400, { error: 'Ungültiges Startdatum.' });
        return;
      }
      persistedRaptStartDate = normalized;
      resetTelemetryCache();
      respondJson(res, 200, { startDate: persistedRaptStartDate });
      return;
    } catch (error) {
      respondJson(res, 400, { error: 'Konnte Startdatum nicht setzen.' });
      return;
    }
  }
  respondJson(res, 405, { error: 'Method not allowed.' });
}

/**
 * Holt einen RAPT-Access-Token für einen konkreten User. Token wird pro userId gecached.
 * Args: { username, apiKey, userId } — Creds kommen aus der DB (user_profiles), userId aus JWT.
 */
async function requestRaptTokenForUser({ username, apiKey, userId }) {
  const now = Date.now();
  const cached = raptTokenCacheByUser.get(userId);
  if (cached && cached.expiry > now + 60000) {
    return cached.data;
  }

  console.log(`[Proxy] Requesting new RAPT token for user ${userId}...`);
  const body = new URLSearchParams({
    client_id: 'rapt-user',
    grant_type: 'password',
    username,
    password: apiKey,
  });

  const response = await fetch(RAPT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`[Proxy] RAPT token request failed (status ${response.status}):`, data);
    const error = new Error(
      data.error_description || data.error || `Failed to fetch RAPT token (${response.status}).`,
    );
    error.statusCode = response.status;
    throw error;
  }

  const expiresIn = data.expires_in || 3600;
  raptTokenCacheByUser.set(userId, { data, expiry: now + expiresIn * 1000 });
  console.log(`[Proxy] New RAPT token cached for user ${userId} (expires in ${expiresIn}s).`);
  return data;
}

// ============================================================================
// Brewfather Proxy (per-user creds via Supabase JWT)
// ============================================================================
// Frontend sendet:  Authorization: Bearer <supabase-jwt>
// Proxy:
//   1. JWT extrahieren, Supabase-Client mit dem JWT bauen
//   2. user_profiles via RLS-scoped Query lesen (User sieht nur eigene Row)
//   3. Basic-Auth-Header für Brewfather aus DB-Creds bauen
//   4. Request 1:1 forwarden, Response zurück
// Brewfather-Credentials verlassen den Server nie Richtung Browser.

function getJwtFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Ruft eine SECURITY DEFINER PostgREST-RPC auf, die intern auth.uid() nutzt
 * und nur die Creds des aufrufenden Users entschlüsselt zurückgibt.
 * Der Proxy braucht keinen service_role-Key — der JWT des Users reicht.
 */
async function callMyCredsRpc(jwt, rpcName, schema = 'aibrewgenius') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not configured in proxy env.');
  }
  const url = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + rpcName;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Profile': schema,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`PostgREST RPC ${rpcName} failed (${resp.status}): ${body}`);
  }
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function getUserRaptCreds(jwt) {
  const row = await callMyCredsRpc(jwt, 'get_my_rapt_creds', 'rapt');
  if (!row || !row.username || !row.api_key) return null;
  return { username: row.username, apiKey: row.api_key };
}

/**
 * Middleware-Helper: prüft JWT, lädt RAPT-Creds aus user_profiles.
 * Bei Fehler wird die Response direkt geschickt und null zurückgegeben.
 * Bei Erfolg: { jwt, userId, raptUsername, raptApiKey }.
 */
async function requireRaptCreds(req, res) {
  const jwt = getJwtFromRequest(req);
  if (!jwt) {
    respondJson(res, 401, { error: 'Authorization Bearer token required.' });
    return null;
  }
  let creds;
  try {
    creds = await getUserRaptCreds(jwt);
  } catch (err) {
    console.error('[RAPT] Supabase auth/profile error:', err.message || err);
    respondJson(res, 401, { error: 'Auth check failed.' });
    return null;
  }
  if (!creds) {
    respondJson(res, 400, {
      error: 'RAPT-Credentials für diesen User nicht hinterlegt. Bitte im Profil eintragen.',
    });
    return null;
  }
  // user_id aus JWT extrahieren (Sub-Claim ohne Validierung — reicht als Cache-Key)
  let userId = 'unknown';
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    userId = payload.sub || 'unknown';
  } catch (_) {}
  return {
    jwt,
    userId,
    raptUsername: creds.username,
    raptApiKey: creds.apiKey,
  };
}

/**
 * Middleware-Helper: prüft, ob der JWT-Bearer valide und nicht abgelaufen ist.
 * Wird von OpenAI-Routen (/api/chat, /api/brew, /api/picture) und der SSO-Issue-Route
 * (/api/sso/rapt-ticket) verwendet.
 *
 * Validierung: GET <SUPABASE_URL>/auth/v1/user mit dem User-JWT als Bearer.
 * Supabase Kong prüft Signatur + Ablaufzeit serverseitig — kein service_role-Key nötig.
 * Bei Fehler: schreibt 401 (generisch, kein Secret-Leak) und gibt null zurück.
 * Bei Erfolg: gibt { userId, email } zurück. Bestehende Caller ignorieren `email` einfach.
 */
async function requireAuthenticatedUser(req, res) {
  const jwt = getJwtFromRequest(req);
  if (!jwt) {
    respondJson(res, 401, { error: 'Authorization Bearer token required.' });
    return null;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[Auth] SUPABASE_URL / SUPABASE_ANON_KEY not configured.');
    respondJson(res, 401, { error: 'Auth check failed.' });
    return null;
  }
  try {
    const authUrl = SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user';
    const authResp = await fetch(authUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    if (!authResp.ok) {
      // Log status only — never log the JWT or response body (may contain token details).
      console.warn(`[Auth] Supabase /auth/v1/user rejected token (status ${authResp.status}).`);
      respondJson(res, 401, { error: 'Unauthorized.' });
      return null;
    }
    const user = await authResp.json().catch(() => null);
    const userId = user?.id || 'unknown';
    // email is needed by the SSO-Issue route; undefined for other callers (harmless).
    const email = typeof user?.email === 'string' ? user.email : undefined;
    return { userId, email };
  } catch (err) {
    console.error('[Auth] requireAuthenticatedUser error:', err.message || err);
    respondJson(res, 401, { error: 'Auth check failed.' });
    return null;
  }
}

async function getUserBrewfatherCreds(jwt) {
  const row = await callMyCredsRpc(jwt, 'get_my_brewfather_creds');
  if (!row || !row.user_id || !row.api_key) return null;
  return { userId: row.user_id, apiKey: row.api_key };
}

async function handleBrewfatherProxyRequest(req, res, url) {
  // 1. JWT prüfen
  const jwt = getJwtFromRequest(req);
  if (!jwt) {
    respondJson(res, 401, { error: 'Authorization Bearer token required.' });
    return;
  }

  let creds;
  try {
    creds = await getUserBrewfatherCreds(jwt);
  } catch (err) {
    console.error('[Brewfather] Supabase auth/profile error:', err.message || err);
    respondJson(res, 401, { error: 'Auth check failed.' });
    return;
  }
  if (!creds) {
    respondJson(res, 400, {
      error: 'Brewfather-Credentials für diesen User nicht hinterlegt. Bitte im Profil eintragen.',
    });
    return;
  }

  // 2. Ziel-URL bauen: /api/brewfather/<rest>?<query>  ->  <BREWFATHER_BASE_URL>/<rest>?<query>
  const subPath = url.pathname.replace(/^\/api\/brewfather/, '');
  const targetUrl = new URL(BREWFATHER_BASE_URL.replace(/\/$/, '') + subPath);
  url.searchParams.forEach((value, key) => targetUrl.searchParams.set(key, value));

  // 3. Basic Auth Header
  const basicAuth =
    'Basic ' + Buffer.from(`${creds.userId}:${creds.apiKey}`).toString('base64');

  // 4. Forward Request
  const fetchHeaders = {
    Authorization: basicAuth,
    Accept: 'application/json',
  };
  const fetchInit = {
    method: req.method,
    headers: fetchHeaders,
    signal: AbortSignal.timeout(BF_FETCH_TIMEOUT_MS),
  };
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    const body = await readBody(req);
    if (body) fetchInit.body = body;
    fetchHeaders['Content-Type'] = req.headers['content-type'] || 'application/json';
  }

  try {
    const bfResponse = await fetch(targetUrl, fetchInit);
    const responseText = await bfResponse.text();
    res.writeHead(bfResponse.status, {
      'Content-Type': bfResponse.headers.get('content-type') || 'application/json',
    });
    res.end(responseText);
  } catch (err) {
    console.error('[Brewfather] Upstream error:', err.message || err);
    if (isTimeoutError(err)) {
      respondJson(res, 504, { error: 'Brewfather upstream request timed out.' });
      return;
    }
    respondJson(res, 502, { error: 'Brewfather upstream request failed.' });
  }
}

// ============================================================================
// SSO Phase 5 — REST-Ticket-Föderations-Routen
// ============================================================================
//
// Übersicht:
//   assistent-Rolle: POST /api/sso/rapt-ticket  (handleSsoTicketRequest)
//     JWT-gated, gibt HMAC-signiertes Kurzzeit-Ticket zurück.
//   rapt-Rolle:      POST /api/sso/redeem        (handleSsoRedeemRequest)
//     Kein User-JWT (begründeter Opt-out: Ticket ist der Auth-Beweis).
//     Verifiziert Ticket, single-use per DB, mintet GoTrue-verwaltete rapt-Session.
//
// Kein service_role-Key in der assistent-Rolle, nirgends global zugänglich.
// RAPT_SERVICE_ROLE_KEY wird ausschließlich lokal in handleSsoRedeemRequest gelesen.
// ============================================================================

// ---------------------------------------------------------------------------
// Hilfsfunktionen: kompaktes JWS (header.payload.sig, base64url, HMAC-SHA256)
// Keine externe Dependency — nur Node-Bordmittel (crypto).
// ---------------------------------------------------------------------------

/**
 * Kodiert einen Buffer oder String als base64url (kein Padding, url-safe).
 */
function base64url(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString('base64url');
}

/**
 * Erstellt ein kompaktes JWS-Token (alg=HS256).
 * Gibt "<header_b64url>.<payload_b64url>.<sig_b64url>" zurück.
 * secret muss ein nicht-leerer String sein.
 */
function ssoTicketSign(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = base64url(JSON.stringify(payload));
  const input  = `${header}.${body}`;
  const sig    = crypto.createHmac('sha256', secret).update(input).digest();
  return `${input}.${base64url(sig)}`;
}

/**
 * Verifiziert ein kompaktes JWS-Token (HMAC-SHA256, constant-time compare).
 * Gibt das geparste Payload-Objekt zurück oder null bei Fehler (ungültige
 * Struktur, Signatur-Mismatch, JSON-Parse-Fehler).
 * Wirft NIE — alle Fehler → null.
 */
function ssoTicketVerify(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sigGiven] = parts;
    const input = `${header}.${body}`;
    const sigExpected = crypto.createHmac('sha256', secret).update(input).digest();
    const sigGivenBuf = Buffer.from(sigGiven, 'base64url');
    // Constant-time compare (beide Puffer müssen gleiche Länge haben für timingSafeEqual)
    if (sigGivenBuf.length !== sigExpected.length) return null;
    if (!crypto.timingSafeEqual(sigGivenBuf, sigExpected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route 1: POST /api/sso/rapt-ticket  (NUR assistent-Rolle)
// ---------------------------------------------------------------------------
// JWT-gated via requireAuthenticatedUser. E-Mail kommt aus /auth/v1/user —
// NICHT aus dem Request-Body (der User darf seine Mapping-Identität nicht wählen).
// ---------------------------------------------------------------------------

async function handleSsoTicketRequest(req, res) {
  // 1. Auth-Gate
  const authCtx = await requireAuthenticatedUser(req, res);
  if (!authCtx) return; // Antwort schon gesendet (401)

  // 2. E-Mail aus dem GoTrue-User-Objekt
  const email = authCtx.email;
  if (typeof email !== 'string' || email.length === 0) {
    respondJson(res, 400, { error: 'User has no email address — cannot issue SSO ticket.' });
    return;
  }

  // 3. Signing-Secret prüfen
  const signingSecret = process.env.SSO_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('[SSO] SSO_SIGNING_SECRET is not set — cannot issue ticket.');
    respondJson(res, 500, { error: 'SSO not configured.' });
    return;
  }

  // 4. Ticket bauen
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'assistent',
    aud: 'rapt',
    email: email.toLowerCase(),
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + SSO_TICKET_TTL_SECS,
  };
  const ticket = ssoTicketSign(payload, signingSecret);

  // 5. Nur das Ticket zurückgeben — kein User-JWT, keine weiteren Felder
  respondJson(res, 200, { ticket });
}

// ---------------------------------------------------------------------------
// Route 2: POST /api/sso/redeem  (NUR rapt-Rolle)
// ---------------------------------------------------------------------------
// Auth-Gating: KEIN User-JWT (begründeter Opt-out — der User hat in rapt noch
// keine Session; das signierte Ticket ist der Auth-Beweis).
//
// service_role-Key wird AUSSCHLIESSLICH hier geladen (lokal, nie global).
// Blast-Radius: nur GoTrue-Admin-Calls (User find/create + Session-Mint).
// jti-Consume läuft über pg-Pool (proxy_sync), NICHT über service_role.
// ---------------------------------------------------------------------------

async function handleSsoRedeemRequest(req, res) {
  // Config-Prüfung zuerst (vor dem Body-Read, um früh zu scheitern)
  const signingSecret = process.env.SSO_SIGNING_SECRET;
  // RAPT_SERVICE_ROLE_KEY: lokal gelesen, nie global exportiert, nie geloggt.
  const raptServiceRoleKey = process.env.RAPT_SERVICE_ROLE_KEY;
  const raptAnonKey = process.env.SUPABASE_ANON_KEY; // = RAPT_ANON_KEY im rapt-Proxy
  if (!signingSecret || !raptServiceRoleKey || !raptAnonKey || !SUPABASE_URL) {
    console.error('[SSO] Missing required env vars (SSO_SIGNING_SECRET / RAPT_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_URL).');
    respondJson(res, 500, { error: 'SSO not configured.' });
    return;
  }

  // Body lesen
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch {
    respondJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const ticketStr = body.ticket;
  if (typeof ticketStr !== 'string' || ticketStr.length === 0) {
    respondJson(res, 400, { error: 'Missing ticket.' });
    return;
  }

  // ── Schritt 1: Signatur verifizieren (constant-time) ──────────────────────
  const payload = ssoTicketVerify(ticketStr, signingSecret);
  if (!payload) {
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }

  // ── Schritt 2: Claims prüfen ──────────────────────────────────────────────
  if (payload.aud !== 'rapt' || payload.iss !== 'assistent') {
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }
  if (typeof payload.email !== 'string' || payload.email.length === 0) {
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }

  // ── Schritt 3: Zeitfenster prüfen ────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    respondJson(res, 401, { error: 'Ticket expired.' });
    return;
  }
  if (payload.exp - payload.iat > 60) {
    // Überlanges Ticket (jemand hat TTL manipuliert)
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }
  if (payload.iat > now + SSO_CLOCK_SKEW_SECS) {
    // iat liegt zu weit in der Zukunft (Clock-Skew-Verletzung)
    respondJson(res, 401, { error: 'Invalid ticket.' });
    return;
  }

  // ── Schritt 4: Single-use jti via pg-Pool (proxy_sync, NICHT service_role) ─
  const pool = dbSync.getPool();
  if (!pool) {
    console.error('[SSO] pg pool not available (db-sync not initialized?).');
    respondJson(res, 503, { error: 'SSO temporarily unavailable.' });
    return;
  }
  let jtiConsumed;
  try {
    // p_exp: Unix-Sekunden → timestamp with time zone (PostgreSQL to_timestamp akzeptiert float)
    const result = await pool.query(
      'SELECT rapt.consume_sso_jti($1, to_timestamp($2)) AS ok',
      [payload.jti, payload.exp]
    );
    jtiConsumed = result.rows[0]?.ok === true;
  } catch (err) {
    console.error('[SSO] consume_sso_jti error:', err.message);
    respondJson(res, 503, { error: 'SSO temporarily unavailable.' });
    return;
  }
  if (!jtiConsumed) {
    // Bereits verbraucht → Replay-Angriff oder Doppel-Einlösung
    respondJson(res, 409, { error: 'Ticket already redeemed.' });
    return;
  }

  const email = payload.email; // lowercase-normalisiert vom Issue-Handler
  const gotruBase = SUPABASE_URL.replace(/\/$/, '');

  // ── Schritt 5: User find-or-create in rapt-Supabase (service_role) ────────
  try {
    const createResp = await fetch(`${gotruBase}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: raptServiceRoleKey,
        Authorization: `Bearer ${raptServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, email_confirm: true }),
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    if (!createResp.ok) {
      const errBody = await createResp.json().catch(() => ({}));
      // GoTrue v2 uses `msg`; newer builds may use `message` — accept both.
      const errMsg = errBody.message || errBody.msg || '';
      const isEmailExists =
        createResp.status === 422 &&
        (errBody.error_code === 'email_exists' ||
          // Substring fallback for GoTrue builds that omit error_code.
          // Actual GoTrue v2 text: "…has already been registered"
          (typeof errMsg === 'string' && errMsg.toLowerCase().includes('already been registered')));
      if (!isEmailExists) {
        console.error(`[SSO] GoTrue admin/users failed (${createResp.status}):`, errMsg || '(no msg)');
        respondJson(res, 502, { error: 'SSO upstream error.' });
        return;
      }
      // 422 email_exists → User existiert bereits → kein Fehler, weiterfahren
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      respondJson(res, 504, { error: 'SSO upstream timeout.' });
      return;
    }
    console.error('[SSO] GoTrue admin/users network error:', err.message);
    respondJson(res, 502, { error: 'SSO upstream error.' });
    return;
  }

  // ── Schritt 6: Session minten via generate_link → verify ─────────────────
  // generate_link gibt hashed_token + verification_type zurück.
  // verification_type ist "signup" für neue User, "magiclink" für bestehende.
  // Wir nutzen den zurückgelieferten Typ in verify (nicht hardcoded "magiclink").
  let hashedToken, verificationType;
  try {
    const glResp = await fetch(`${gotruBase}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: raptServiceRoleKey,
        Authorization: `Bearer ${raptServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', email }),
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    const glBody = await glResp.json().catch(() => ({}));
    if (!glResp.ok) {
      const errMsg = glBody.message || glBody.msg || '(no msg)';
      console.error(`[SSO] GoTrue generate_link failed (${glResp.status}):`, errMsg);
      respondJson(res, 502, { error: 'SSO upstream error.' });
      return;
    }
    hashedToken = glBody.hashed_token;
    verificationType = glBody.verification_type;
    if (!hashedToken || !verificationType) {
      console.error('[SSO] generate_link response missing hashed_token or verification_type. Shape:', JSON.stringify(Object.keys(glBody)));
      respondJson(res, 502, { error: 'SSO upstream error.' });
      return;
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      respondJson(res, 504, { error: 'SSO upstream timeout.' });
      return;
    }
    console.error('[SSO] GoTrue generate_link network error:', err.message);
    respondJson(res, 502, { error: 'SSO upstream error.' });
    return;
  }

  // verify — KEIN service_role hier, nur ANON_KEY
  let session;
  try {
    const verifyResp = await fetch(`${gotruBase}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        apikey: raptAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: verificationType, token_hash: hashedToken }),
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    session = await verifyResp.json().catch(() => null);
    if (!verifyResp.ok) {
      const errMsg = (session && (session.message || session.msg)) || '(no msg)';
      console.error(`[SSO] GoTrue verify failed (${verifyResp.status}):`, errMsg);
      session = null;
      respondJson(res, 502, { error: 'SSO upstream error.' });
      return;
    }
    if (!session || !session.access_token || !session.refresh_token) {
      console.error('[SSO] GoTrue verify response missing access_token/refresh_token.');
      respondJson(res, 502, { error: 'SSO upstream error.' });
      return;
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      respondJson(res, 504, { error: 'SSO upstream timeout.' });
      return;
    }
    console.error('[SSO] GoTrue verify network error:', err.message);
    respondJson(res, 502, { error: 'SSO upstream error.' });
    return;
  }

  // ── Schritt 7: Nur Session-Felder zurückgeben (kein service_role, kein Ticket, kein hashed_token) ─
  respondJson(res, 200, {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// SSRF guard for /api/proxy-image
// ---------------------------------------------------------------------------
// Returns true only when `rawUrl` is a syntactically valid https: URL whose
// resolved host is a publicly-routable address.
//
// IP ranges blocked (RFC-1918, loopback, link-local, unique-local):
//   IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
//         169.254.0.0/16 (link-local / AWS metadata)
//   IPv6: ::1, fc00::/7 (unique-local), fe80::/10 (link-local)
//
// DNS resolution is attempted once (A/AAAA) to catch numeric-IP hostnames and
// private-range aliases. This is a best-effort first cut: a determined attacker
// with a DNS-rebinding attack could still bypass, but that requires TTL tricks
// beyond typical SSRF. A stricter approach would re-resolve at fetch time —
// flagged for future hardening if needed.
async function isSafePublicHttpsUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname;

  // Block literal IPs in private ranges before DNS lookup.
  if (isPrivateIp(hostname)) return false;

  // Also block bare "localhost" (case-insensitive) and .local/.internal TLDs.
  const lc = hostname.toLowerCase();
  if (lc === 'localhost') return false;
  if (lc.endsWith('.local') || lc.endsWith('.internal')) return false;

  // Resolve hostname and check every returned address.
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) return false;
    }
  } catch {
    // DNS resolution failure → treat as unsafe (don't fetch unknown hosts).
    return false;
  }

  return true;
}

// Returns true if `ip` (string) falls within a private/loopback/link-local range.
function isPrivateIp(ip) {
  // IPv6 loopback
  if (ip === '::1') return true;

  // Strip IPv6 brackets e.g. [::1]
  const addr = ip.startsWith('[') ? ip.slice(1, -1) : ip;

  // IPv6 unique-local fc00::/7 and link-local fe80::/10
  if (addr.includes(':')) {
    const lc = addr.toLowerCase();
    if (lc === '::1') return true;
    // fc00::/7 covers fc00:: – fdff::
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;
    // fe80::/10
    if (lc.startsWith('fe8') || lc.startsWith('fe9') ||
        lc.startsWith('fea') || lc.startsWith('feb')) return true;
    return false;
  }

  // IPv4
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;                              // 127.0.0.0/8  loopback
  if (a === 10) return true;                               // 10.0.0.0/8   private
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;                 // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 link-local / metadata
  return false;
}

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Returns true when an error is an AbortSignal timeout (DOMException name
 * "TimeoutError") or a plain AbortError, so callers can reply with 504.
 */
function isTimeoutError(err) {
  if (!err) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

function normalizeStartDateParam(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function resetTelemetryCache() {
  telemetryCache = null;
  telemetryCacheTimestamp = 0;
  try {
    fs.unlinkSync(TELEMETRY_CACHE_FILE);
  } catch (error) {
    // ignore missing file
  }
}

function saveTelemetryCacheToDisk() {
  const data = {
    timestamp: telemetryCacheTimestamp,
    payload: telemetryCache,
    persistedStartDate: persistedRaptStartDate,
  };
  fs.writeFile(TELEMETRY_CACHE_FILE, JSON.stringify(data), err => {
    if (err) {
      console.warn('Failed to persist telemetry cache:', err.message || err);
    }
  });
}

function loadTelemetryCacheFromDisk() {
  try {
    const raw = fs.readFileSync(TELEMETRY_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.timestamp === 'number' && data.payload) {
      telemetryCacheTimestamp = data.timestamp;
      telemetryCache = data.payload;
      if (telemetryCache?.startDate) {
        lastEffectiveStartDate = telemetryCache.startDate;
      }
      if (data.persistedStartDate) {
        persistedRaptStartDate = data.persistedStartDate;
      }
      console.log('Telemetry cache restored from disk.');
    }
  } catch (error) {
    // ignore missing or invalid cache file
  }
}

function saveControllersCacheToDisk() {
  if (!controllersCache) return;
  fs.writeFile(CONTROLLER_CACHE_FILE, JSON.stringify(controllersCache), err => {
    if (err) {
      console.warn('Failed to persist controller cache:', err.message || err);
    }
  });
}

function loadControllersCacheFromDisk() {
  try {
    const raw = fs.readFileSync(CONTROLLER_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.controllers)) {
      controllersCache = data;
    }
  } catch (error) {
    // ignore missing/invalid file
  }
}

async function ensureTelemetryCache(options = {}) {
  const { force = false, startDateOverride = null, userCtx = null } = options;
  // userCtx ist optional: bei foreground-Anfragen ist es der eingeloggte User
  // (siehe handleRaptTelemetryRequest). Ohne Context kann nicht refresht werden —
  // dann nur Cache zurückgeben.
  if (!userCtx) {
    if (telemetryCache) return telemetryCache;
    throw new Error('Kein User-Context für RAPT-Refresh und kein Cache vorhanden.');
  }

  if (startDateOverride) {
    if (!force && telemetryCache && telemetryCache.requestedStartDate === startDateOverride) {
      return telemetryCache;
    }
    return refreshTelemetryCache(startDateOverride, false, userCtx);
  }

  if (force || !telemetryCache) {
    if (!telemetryCachePromise) {
      console.log(`[Proxy] Starting telemetry refresh (force=${force}) for user ${userCtx.userId}...`);
      telemetryCachePromise = refreshTelemetryCache(null, false, userCtx)
        .then(data => {
          console.log('[Proxy] Telemetry refresh successful.');
          return data;
        })
        .catch(err => {
          console.error('[Proxy] Telemetry refresh failed in promise:', err.message);
          throw err;
        })
        .finally(() => {
          telemetryCachePromise = null;
        });
    } else {
      console.log('[Proxy] Telemetry refresh already in progress, joining existing promise.');
    }
    return telemetryCachePromise;
  }
  return telemetryCache;
}

async function refreshTelemetryCache(startDateOverride = null, hasFallback = false, userCtx = null) {
  if (!userCtx) {
    throw new Error('refreshTelemetryCache: userCtx erforderlich (kein env-fallback mehr).');
  }
  const token = await requestRaptTokenForUser(userCtx);
  if (!token?.access_token) {
    const err = new Error('Token response invalid.');
    err.statusCode = 502;
    throw err;
  }

  const base = RAPT_API_BASE.replace(/\/$/, '');

  // 1. Fetch Controllers & Hydrometers (concurrently)
  const [controllers, hydrometers] = await Promise.all([
    fetchTemperatureControllers(base, token.access_token).catch(err => {
      console.warn('[Proxy] Failed to fetch controllers during refresh:', err.message);
      return [];
    }),
    fetchHydrometers(base, token.access_token).catch(err => {
      console.warn('[Proxy] Failed to fetch hydrometers during refresh:', err.message);
      return [];
    })
  ]);

  const filteredControllers = filterControllersForUse(controllers, RAPT_CONTROLLER_USE);
  updateControllersCache(filteredControllers);

  const cachedRowsByController = mapRowsByControllerId(telemetryCache?.rows || []);
  const nowIso = new Date().toISOString();
  const rows = [];
  let firstProfileName = null;

  for (const controller of filteredControllers) {
    const controllerId = getControllerIdentifier(controller);
    const profileName =
      controller?.activeProfileSession?.name ||
      controller?.activeProfileSession?.Name ||
      controller?.name ||
      null;

    let hydrometerId = getHydrometerIdFromController(controller);

    // Auto-Link: If no hydrometerId found on controller, search in hydrometers list by pairedDeviceId
    if (!hydrometerId && controllerId) {
      const matchedPill = hydrometers.find(h =>
        h.pairedDeviceId === controllerId ||
        h.PairedDeviceId === controllerId
      );
      if (matchedPill) {
        hydrometerId = matchedPill.id || matchedPill.Id;
      }
    }
    const hasActiveSession = controllerHasActiveSession(controller);
    const fallbackStart = getControllerStartDate(controller);
    const startDate = startDateOverride || fallbackStart;
    const cachedRowsForController =
      controllerId && cachedRowsByController.has(controllerId)
        ? cachedRowsByController.get(controllerId)
        : null;

    // Logging debug info for decision
    console.log(`[DEBUG] refreshTelemetryCache for ${controllerId}: active=${hasActiveSession}, override=${startDateOverride}, cachedRows=${cachedRowsForController?.length}`);

    // If user provided a specific start date (override), we assume they want historical data
    // regardless of whether there is an "active session" right now.
    // Otherwise, if no session is active and no override, we just serve cache.
    if (!hasActiveSession && !startDateOverride) {
      console.log('[DEBUG] Reusing cache because no active session and no override.');
      if (cachedRowsForController && cachedRowsForController.length) {
        cachedRowsForController.forEach(entry => {
          rows.push({
            ...entry,
            reusedFromCache: true,
          });
        });
        if (!firstProfileName) {
          const cachedName = cachedRowsForController.find(r => r?.profileName)?.profileName;
          if (cachedName) {
            firstProfileName = cachedName;
          }
        }
        continue;
      }
      rows.push({
        controllerId,
        hydrometerId: hydrometerId || '(unbekannt)',
        error: 'Kein aktiver Controller-Prozess. Telemetrie aus Cache nicht verfügbar.',
      });
      continue;
    }

    if (!hydrometerId) {
      rows.push({
        controllerId,
        hydrometerId: '(unbekannt)',
        error: 'Controller ohne gültige Hydrometer-ID.',
      });
      continue;
    }

    if (!startDate) {
      rows.push({
        controllerId,
        hydrometerId,
        error: 'Kein Startdatum im Controller vorhanden.',
      });
      continue;
    }

    if (!firstProfileName && profileName) {
      firstProfileName = profileName;
    }

    try {
      const teleData = await requestHydrometerTelemetry(
        base,
        token.access_token,
        hydrometerId,
        startDate,
        nowIso,
      );
      const entries = Array.isArray(teleData) ? teleData : [teleData];
      for (const entry of entries) {
        rows.push({
          controllerId,
          controllerName: controller?.name || controller?.controllerName || null,
          hydrometerId,
          startDate: entry?.startDate || entry?.StartDate || startDate || null,
          createdOn: entry?.createdOn || entry?.CreatedOn || null,
          temperature: entry?.temperature ?? entry?.Temperature ?? null,
          gravity: entry?.gravity ?? entry?.Gravity ?? null,
          gravityVelocity: entry?.gravityVelocity ?? entry?.GravityVelocity ?? null,
          battery: entry?.battery ?? entry?.Battery ?? null,
          macAddress: entry?.macAddress || entry?.MacAddress || null,
          profileName,
        });
      }
    } catch (telemetryError) {
      const status = telemetryError?.statusCode || telemetryError?.status;
      const shouldFallback =
        !!startDateOverride &&
        !hasFallback &&
        (status === 400 || status === 404 || status === 504);

      if (shouldFallback) {
        persistedRaptStartDate = null;
        return refreshTelemetryCache(null, true, userCtx);
      }

      rows.push({
        controllerId,
        hydrometerId,
        error: telemetryError.details || telemetryError.message || 'Telemetry request failed.',
      });
    }
  }

  const hasValidRows = rows.some(row => row && !row.error);

  if (!hasValidRows && telemetryCache && Array.isArray(telemetryCache.rows) && telemetryCache.rows.length) {
    console.warn('Telemetry refresh yielded no valid rows – keeping previous cache.');
    return telemetryCache;
  }

  rows.sort((a, b) => {
    const da = new Date(a.startDate || 0).getTime();
    const db = new Date(b.startDate || 0).getTime();
    return da - db;
  });

  const firstStart = rows[0]?.startDate || null;
  const payload = {
    rows,
    generatedAt: nowIso,
    startDate: startDateOverride || firstStart,
    endDate: nowIso,
    profileName: firstProfileName,
    requestedStartDate: startDateOverride || null,
  };
  telemetryCache = payload;
  telemetryCacheTimestamp = Date.now();
  lastEffectiveStartDate = payload.startDate || null;
  saveTelemetryCacheToDisk();
  return payload;
}

async function fetchTemperatureControllers(base, accessToken) {
  const now = Date.now();
  // Limit fetches to once per minute unless there is no cache
  if (controllersCache && Array.isArray(controllersCache.controllers) && (now - lastControllersFetchTime < 60000)) {
    console.log('[Proxy] Using cached controllers list due to cooldown.');
    return controllersCache.controllers;
  }

  lastControllersFetchTime = now;
  const response = await fetch(`${base}${RAPT_CONTROLLERS_ENDPOINT}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    if (response.status === 429) {
      console.warn('[Proxy] RAPT API Rate Limit (429) hit on controllers endpoint.');
    } else {
      console.error(`[Proxy] Controller fetch failed (${response.status}):`, payload);
    }
    const err = new Error(response.status === 429 ? 'RAPT API Rate Limit hit. Please wait.' : 'Temperature controller response invalid.');
    err.statusCode = response.status;
    err.details = payload;
    throw err;
  }
  return normalizeControllerArray(payload);
}

async function fetchHydrometers(base, accessToken) {
  const now = Date.now();
  if (cachedHydrometers.length > 0 && (now - lastHydrometersFetchTime < 60000)) {
    return cachedHydrometers;
  }

  lastHydrometersFetchTime = now;
  const response = await fetch(`${base}/api/Hydrometers/GetHydrometers`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    if (response.status === 429) {
      console.warn('[Proxy] RAPT API Rate Limit (429) hit on hydrometers endpoint.');
    }
    const err = new Error('Hydrometer response invalid.');
    err.statusCode = response.status;
    err.details = payload;
    throw err;
  }
  cachedHydrometers = normalizeControllerArray(payload);
  return cachedHydrometers;
}

function normalizeControllerArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.$values)) {
    return payload.$values;
  }
  if (payload && Array.isArray(payload.controllers)) {
    return payload.controllers;
  }
  if (payload && Array.isArray(payload.value)) {
    return payload.value;
  }
  return [];
}

function filterControllersForUse(controllers, desiredUse) {
  if (!Array.isArray(controllers)) {
    return [];
  }
  const normalizedDesired = typeof desiredUse === 'string' ? desiredUse.trim().toLowerCase() : '';
  if (!normalizedDesired) {
    return controllers;
  }
  const filtered = controllers.filter(controller => {
    const rawUse = controller?.customerUse || controller?.CustomerUse;
    if (!rawUse) {
      return false;
    }
    return String(rawUse).trim().toLowerCase() === normalizedDesired;
  });
  return filtered.length ? filtered : controllers;
}

function updateControllersCache(controllers) {
  const normalized = Array.isArray(controllers) ? controllers : [];
  const nowIso = new Date().toISOString();
  const previousSelected = controllersCache?.selectedId || null;
  let selectedId = previousSelected && normalized.some(c => getControllerIdentifier(c) === previousSelected)
    ? previousSelected
    : null;
  if (!selectedId && normalized.length) {
    selectedId = getControllerIdentifier(normalized[0]) || null;
  }
  controllersCache = {
    controllers: normalized,
    selectedId,
    timestamp: nowIso,
  };
  saveControllersCacheToDisk();
}

function getControllerIdentifier(controller) {
  if (!controller) return null;
  return (
    controller?.id ||
    controller?.Id ||
    controller?.temperatureControllerId ||
    controller?.TemperatureControllerId ||
    null
  );
}

function getHydrometerIdFromController(controller) {
  if (!controller) return null;
  const session = controller?.activeProfileSession || controller?.ActiveProfileSession || {};
  return (
    controller?.hydrometerId ||
    controller?.HydrometerId ||
    session?.hydrometerId ||
    session?.HydrometerId ||
    controller?.activeProfileSession?.hydrometerId ||
    controller?.activeProfileSession?.HydrometerId ||
    null
  );
}

function getControllerStartDate(controller) {
  if (!controller) return null;
  const session = controller?.activeProfileSession || controller?.ActiveProfileSession || {};
  const candidates = [
    session?.startDate,
    session?.StartDate,
    session?.startTime,
    session?.StartTime,
    session?.startTimestamp,
    session?.StartTimestamp,
    session?.sessionStart,
    session?.SessionStart,
    controller?.startDate,
    controller?.StartDate,
    controller?.startTime,
    controller?.StartTime,
    controller?.activeProfileStartTime,
    controller?.ActiveProfileStartTime,
  ];
  for (const value of candidates) {
    if (value) {
      return value;
    }
  }
  return null;
}

function controllerHasActiveSession(controller) {
  if (!controller) return false;
  return !!(controller?.activeProfileSession || controller?.ActiveProfileSession);
}

function mapRowsByControllerId(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) {
    return map;
  }
  rows.forEach(row => {
    if (!row || !row.controllerId) {
      return;
    }
    if (!map.has(row.controllerId)) {
      map.set(row.controllerId, []);
    }
    map.get(row.controllerId).push(row);
  });
  return map;
}

async function requestHydrometerTelemetry(base, accessToken, hydrometerId, startDate, endDate) {
  const telemetryUrl = new URL(`${base}${RAPT_TELEMETRY_ENDPOINT}`);
  telemetryUrl.searchParams.set('hydrometerId', hydrometerId);
  telemetryUrl.searchParams.set('startDate', startDate);
  if (endDate) {
    telemetryUrl.searchParams.set('endDate', endDate);
  }
  const response = await fetch(telemetryUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    if (response.status === 429) {
      console.warn(`[Proxy] RAPT API Rate Limit (429) hit on telemetry endpoint for hydrometer ${hydrometerId}.`);
    } else {
      console.error(`[Proxy] Telemetry fetch failed (${response.status}) for ${hydrometerId}:`, payload);
    }
    const err = new Error(response.status === 429 ? 'RAPT API Rate Limit hit. Please wait.' : 'Telemetry response invalid.');
    err.statusCode = response.status;
    err.details = payload;
    throw err;
  }
  return payload;
}

function getLastKnownStartDate() {
  return persistedRaptStartDate || lastEffectiveStartDate || telemetryCache?.startDate || null;
}


function hasActiveSessionInCache() {
  // Check in-memory first
  if (controllersCache && Array.isArray(controllersCache.controllers)) {
    return controllersCache.controllers.some(c => controllerHasActiveSession(c));
  }
  return false;
}


function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .forEach(line => {
        const idx = line.indexOf('=');
        if (idx === -1) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`No env file loaded at ${filePath}`);
    }
  }
}

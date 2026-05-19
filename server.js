const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { searchShops } = require('./services/shopCrawler');

const BASE_PATH = __dirname;
const LOCAL_ENV = process.env.PROXY_ENV ?? path.join(BASE_PATH, '.env');
const CACHE_DIR = path.join(BASE_PATH, 'cache');
const TELEMETRY_CACHE_FILE = path.join(CACHE_DIR, 'telemetry-cache.json');
const LAST_TELEMETRY_CACHE_FILE = path.join(CACHE_DIR, 'last-telemetry-cache.json');
const CONTROLLER_CACHE_FILE = path.join(CACHE_DIR, 'controllers-cache.json');
const LAST_CONTROLLER_CACHE_FILE = path.join(CACHE_DIR, 'last-controllers-cache.json');

loadEnvFile(LOCAL_ENV);
fs.mkdirSync(CACHE_DIR, { recursive: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RAPT_USERNAME = process.env.RAPT_USERNAME;
const RAPT_API_KEY = process.env.RAPT_API_KEY;
const RAPT_TOKEN_ENDPOINT = process.env.RAPT_TOKEN_ENDPOINT ?? 'https://id.rapt.io/connect/token';
const RAPT_API_BASE = process.env.RAPT_API_BASE ?? 'https://api.rapt.io';
const RAPT_PROFILE_ENDPOINT = process.env.RAPT_PROFILE_ENDPOINT ?? '/api/Profiles/GetProfiles';
const RAPT_CONTROLLERS_ENDPOINT =
  process.env.RAPT_CONTROLLER_ENDPOINT ?? '/api/TemperatureControllers/GetTemperatureControllers';
const RAPT_TELEMETRY_ENDPOINT = process.env.RAPT_TELEMETRY_ENDPOINT ?? '/api/Hydrometers/GetTelemetry';
const RAPT_CONTROLLER_USE = process.env.RAPT_CONTROLLER_USE ?? 'Beer Fermentation';
const PORT = Number(process.env.PORT ?? 3000);
const CACHE_INTERVAL_MS = Number(process.env.RAPT_CACHE_INTERVAL_MS ?? 60 * 60 * 1000);
const ALLOWED_ORIGIN_RAW = process.env.CORS_ORIGIN ?? '*';
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_RAW.split(',')
  .map(value => value.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.includes('*');

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Provide it via environment variable or proxy/.env file.');
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
let raptTokenCache = null;
let raptTokenExpiry = 0;

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
      res.end(JSON.stringify({ status: 'Proxy is running', version: '0.1.0' }));
      return;
    }

    if (url.pathname === '/api/rapt/hydrometers' && req.method === 'GET') {
      await handleRaptHydrometersRequest(res);
      return;
    }
    if (url.pathname === '/api/rapt/hydrometer-telemetry' && req.method === 'GET') {
      await handleDirectHydrometerTelemetryRequest(req, res);
      return;
    }

    if (url.pathname === '/api/brew' && req.method === 'POST') {
      await handleBrewRequest(req, res);
      return;
    }
    if (url.pathname === '/api/shop-search' && req.method === 'POST') {
      await handleShopSearchRequest(req, res);
      return;
    }
    if (url.pathname === '/api/rapt/token' && req.method === 'POST') {
      await handleRaptTokenRequest(res);
      return;
    }
    if (url.pathname === '/api/rapt/profiles' && req.method === 'GET') {
      await handleRaptProfilesRequest(res);
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
    if (url.pathname === '/api/cache/telemetry' && req.method === 'GET') {
      await handleTelemetryCacheResponse(res);
      return;
    }
    if (url.pathname === '/api/cache/controllers' && req.method === 'GET') {
      await handleControllerCacheResponse(res);
      return;
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
  console.log(`Proxy listening on http://localhost:${PORT}`);
  dbSync.init();   // Periodic sync RAPT API → Postgres (rapt.* schema)
  const initialForce = !telemetryCache;
  ensureTelemetryCache({
    force: initialForce,
    startDateOverride: getLastKnownStartDate(),
  }).catch(err => {
    console.error('Initial telemetry preload failed:', err.message || err);
  });
  scheduleHourlyTelemetryRefresh();
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
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Du bist ein nützlicher Assistent für einen Braumeister. Antworte präzise auf seine Fragen oder Anweisungen.',
          },
          { role: 'user', content: userContent },
        ],
        temperature: 0.7,
      }),
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
    respondJson(res, 500, { error: 'Interner Proxy-Fehler.' });
  }
}

async function handleGenerateImageRequest(req, res) {
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
    });

    const refinePayload = await refineResponse.json();
    const refinedPrompt = refinePayload.choices?.[0]?.message?.content?.trim();

    if (!refinedPrompt) {
      respondJson(res, 502, { error: 'Prompt-Refinement fehlgeschlagen.', details: refinePayload });
      return;
    }

    // --- Step 2: Generate Image with DALL-E 3 ---
    const dallEResponse = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: refinedPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      }),
    });

    const dallEPayload = await dallEResponse.json();

    if (!dallEResponse.ok) {
      console.error('DALL-E API error:', dallEResponse.status, dallEPayload);
      respondJson(res, dallEResponse.status, {
        error: dallEPayload?.error?.message || 'DALL-E generation failed.',
      });
      return;
    }

    const imageUrl = dallEPayload.data?.[0]?.url;
    if (!imageUrl) {
      respondJson(res, 502, { error: 'Kein Bild-URL von DALL-E erhalten.' });
      return;
    }

    respondJson(res, 200, { result: imageUrl });
  } catch (error) {
    console.error('Proxy error:', error);
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

    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      respondJson(res, imageResponse.status, { error: 'Failed to fetch image from source.' });
      return;
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/png';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });

    const arrayBuffer = await imageResponse.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));

  } catch (error) {
    console.error('Proxy image error:', error);
    respondJson(res, 500, { error: 'Interner Proxy-Fehler beim Laden des Bildes.' });
  }
}

async function handleBrewRequest(req, res) {
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
    });

    const payload = await openAiResponse.json();

    if (!openAiResponse.ok) {
      console.error('OpenAI API error:', openAiResponse.status, payload);
      respondJson(res, openAiResponse.status, {
        error: payload?.error?.message || payload?.error || 'OpenAI API request failed.',
        details: payload,
      });
      return;
    }

    const content = extractResponseText(payload);

    if (!content) {
      respondJson(res, 502, { error: 'Antwort von OpenAI unvollständig.', payload });
      return;
    }

    respondJson(res, 200, { result: content.trim() });
  } catch (error) {
    console.error('Proxy error:', error);
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

async function handleRaptTokenRequest(res) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    respondJson(res, 500, { error: 'RAPT credentials not configured.' });
    return;
  }
  try {
    const tokenData = await requestRaptToken();
    respondJson(res, 200, tokenData);
  } catch (error) {
    console.error('RAPT token error:', error);
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT token request failed.' });
  }
}

async function handleRaptProfilesRequest(res) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    respondJson(res, 500, { error: 'RAPT credentials not configured.' });
    return;
  }
  try {
    const token = await requestRaptToken();
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');
    const apiResponse = await fetch(`${base}${RAPT_PROFILE_ENDPOINT}`, {
      headers: {
        'Authorization': `Bearer ${token.access_token}`,
        'Accept': 'application/json',
      },
    });
    const payload = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }
    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT devices error:', error);
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT devices request failed.' });
  }
}

async function handleRaptHydrometersRequest(res) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    respondJson(res, 500, { error: 'RAPT credentials not configured.' });
    return;
  }
  try {
    const token = await requestRaptToken();
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');
    const apiResponse = await fetch(`${base}/api/Hydrometers/GetHydrometers`, {
      headers: {
        'Authorization': `Bearer ${token.access_token}`,
        'Accept': 'application/json',
      },
    });
    const payload = await apiResponse.json().catch(() => ([]));
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }
    respondJson(res, 200, payload);
  } catch (error) {
    console.error('RAPT hydrometers error:', error);
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT hydrometers request failed.' });
  }
}

async function handleDirectHydrometerTelemetryRequest(req, res) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    respondJson(res, 500, { error: 'RAPT credentials not configured.' });
    return;
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hydrometerId = url.searchParams.get('hydrometerId');
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');

    if (!hydrometerId || !startDate || !endDate) {
      respondJson(res, 400, { error: 'Missing parameters: hydrometerId, startDate, endDate' });
      return;
    }

    const token = await requestRaptToken();
    if (!token?.access_token) {
      respondJson(res, 502, { error: 'Token response invalid.' });
      return;
    }
    const base = RAPT_API_BASE.replace(/\/$/, '');

    // determine URL - ensure we use the correct endpoint path
    const teleUrl = new URL(`${base}/api/Hydrometers/GetTelemetry`);
    teleUrl.searchParams.set('hydrometerId', hydrometerId);
    teleUrl.searchParams.set('startDate', startDate);
    teleUrl.searchParams.set('endDate', endDate);

    const apiResponse = await fetch(teleUrl, {
      headers: {
        'Authorization': `Bearer ${token.access_token}`,
        'Accept': 'application/json',
      },
    });

    const payload = await apiResponse.json().catch(() => ([]));
    if (!apiResponse.ok) {
      respondJson(res, apiResponse.status, payload);
      return;
    }

    respondJson(res, 200, payload);

  } catch (error) {
    console.error('RAPT direct telemetry error:', error);
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT telemetry request failed.' });
  }
}

async function handleRaptTelemetryRequest(req, res) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    respondJson(res, 500, { error: 'RAPT credentials not configured.' });
    return;
  }
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
      });
    let payloadData = data;
    const isLiveRequest = !effectiveStartOverride;

    if (isLiveRequest && !hasActiveSessionInCache()) {
      const fallback = tryServeFallback();
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
    const status = error.statusCode ?? 500;
    respondJson(res, status, { error: error.message ?? 'RAPT telemetry request failed.' });
  }
}

async function handleTelemetryCacheResponse(res) {
  let dataToSend = telemetryCache;

  if (!dataToSend) {
    try {
      await ensureTelemetryCache({ force: false });
      dataToSend = telemetryCache;
    } catch (error) {
      console.warn('Unable to refresh telemetry cache:', error.message || error);
    }
  }

  // Fallback Logic for Cache Endpoint
  if (!hasActiveSessionInCache()) {
    const fallback = tryServeFallback();
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

function tryServeFallback() {
  try {
    if (fs.existsSync(LAST_TELEMETRY_CACHE_FILE)) {
      const raw = fs.readFileSync(LAST_TELEMETRY_CACHE_FILE, 'utf8');
      const diskData = JSON.parse(raw);
      const potentialPayload = diskData.payload || diskData;

      if (potentialPayload && Array.isArray(potentialPayload.rows) && potentialPayload.rows.length) {
        // Check if rows are actually valid (no error)
        if (!potentialPayload.rows[0].error) {
          console.log(`[Proxy] Serving fallback with ${potentialPayload.rows.length} rows.`);
          // Ensure isFallback flag
          return { ...potentialPayload, isFallback: true };
        }
      }
    }
  } catch (err) {
    console.warn('[Proxy] Fallback read failed:', err.message);
  }
  return null;
}

async function handleControllerCacheResponse(res) {
  let dataToSend = controllersCache;

  if (!dataToSend) {
    try {
      await ensureTelemetryCache({ force: false });
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

async function requestRaptToken() {
  const now = Date.now();
  if (raptTokenCache && raptTokenExpiry > now + 60000) {
    return raptTokenCache;
  }

  console.log('[Proxy] Requesting new RAPT token...');
  const body = new URLSearchParams({
    client_id: 'rapt-user',
    grant_type: 'password',
    username: RAPT_USERNAME,
    password: RAPT_API_KEY,
  });

  const response = await fetch(RAPT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`[Proxy] Token request failed with status ${response.status}:`, data);
    const error = new Error(data.error_description || data.error || `Failed to fetch RAPT token (${response.status}).`);
    error.statusCode = response.status;
    throw error;
  }

  raptTokenCache = data;
  const expiresIn = data.expires_in || 3600;
  raptTokenExpiry = now + (expiresIn * 1000);
  console.log(`[Proxy] New RAPT token received (expires in ${expiresIn}s).`);
  return data;
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

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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
  const { force = false, startDateOverride = null } = options;

  if (startDateOverride) {
    if (!force && telemetryCache && telemetryCache.requestedStartDate === startDateOverride) {
      return telemetryCache;
    }
    return refreshTelemetryCache(startDateOverride);
  }

  if (force || !telemetryCache) {
    if (!telemetryCachePromise) {
      console.log(`[Proxy] Starting telemetry refresh (force=${force})...`);
      telemetryCachePromise = refreshTelemetryCache()
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

async function refreshTelemetryCache(startDateOverride = null, hasFallback = false) {
  if (!RAPT_USERNAME || !RAPT_API_KEY) {
    throw new Error('RAPT credentials not configured.');
  }

  const token = await requestRaptToken();
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
        return refreshTelemetryCache(null, true);
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


function scheduleHourlyTelemetryRefresh() {
  const scheduleNext = () => {
    const delay = getMsUntilNextHour();
    console.log(`[Scheduler] Next telemetry refresh scheduled in ${Math.round(delay / 1000 / 60)} minutes.`);
    setTimeout(async () => {
      console.log('[Scheduler] Starting hourly telemetry refresh...');

      // 1. Backup current cache to 'last-' files ONLY if we currently have an active session.
      // This ensures 'last' files always contain the most recent *active* state.
      try {
        if (hasActiveSessionInCache()) {
          console.log('[Scheduler] Active session detected in current cache. Backing up to last-cache files.');
          if (fs.existsSync(TELEMETRY_CACHE_FILE)) {
            fs.copyFileSync(TELEMETRY_CACHE_FILE, LAST_TELEMETRY_CACHE_FILE);
          }
          if (fs.existsSync(CONTROLLER_CACHE_FILE)) {
            fs.copyFileSync(CONTROLLER_CACHE_FILE, LAST_CONTROLLER_CACHE_FILE);
          }
        } else {
          console.log('[Scheduler] No active session in current cache. Skipping backup to preserve previous active state.');
        }
      } catch (backupErr) {
        console.error('[Scheduler] Backup failed:', backupErr);
      }

      // 2. Refresh Telemetry
      try {
        await ensureTelemetryCache({
          force: true,
          startDateOverride: getLastKnownStartDate(),
        });
        console.log('[Scheduler] Hourly refresh completed.');
      } catch (err) {
        console.error('[Scheduler] Telemetry refresh failed:', err.message || err);
      }

      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function hasActiveSessionInCache() {
  // Check in-memory first
  if (controllersCache && Array.isArray(controllersCache.controllers)) {
    return controllersCache.controllers.some(c => controllerHasActiveSession(c));
  }
  return false;
}

function getMsUntilNextHour(referenceTime = Date.now()) {
  const referenceDate = new Date(referenceTime);
  referenceDate.setMinutes(0, 0, 0);
  // Add 1 hour
  const nextHourMs = referenceDate.getTime() + (60 * 60 * 1000);
  // If we are currently exactly at 00, add another hour? 
  // ensureTelemetryCache runs, then schedules next. 
  // If we are at 09:00:01, next is 10:00:00.
  // The logic below adds INTERVAL (which is 1h) to the rounded-down hour?
  // Original logic: referenceDate + CACHE_INTERVAL_MS. 
  // If referenceDate is 09:00:00, +1h = 10:00:00.
  // If current time is 09:30, referenceDate is 09:00. +1h = 10:00. diff = 30min. Correct.
  // But usage of CACHE_INTERVAL_MS variable is safer if we want to config it.
  // Assuming CACHE_INTERVAL_MS is 1 hour (3600000).
  const nextHourMsCalculated = referenceDate.getTime() + 3600000;

  // Calculate delay, but ensure we don't fire immediately if we are super close
  const delay = nextHourMsCalculated - referenceTime;
  // If delay is negative (shouldn't happen with math above) or very small, wait 1h?
  // For safety, just use the logic: Next top of the hour.

  return Math.max(1000, delay);
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

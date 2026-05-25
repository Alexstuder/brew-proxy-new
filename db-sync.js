// Periodic worker: pollt RAPT API, persistiert in Supabase Postgres (rapt.* tables).
// - Stammdaten (controllers, hydrometers, profiles): UPSERT alle Sync-Zyklen
// - Telemetrie: incrementally (seit MAX(created_on) pro Gerät), INSERT ON CONFLICT DO NOTHING
// - brew_sessions: aggregiert via rapt.derive_brew_sessions_for(owner) (serverseitig, per User)
//
// Phase 2 (rapt/005_rapt_telemetry_owner.sql): alle Schreibpfade laufen über
// SECURITY DEFINER-RPCs (proxy_sync hat keinen direkten Tabellenzugriff mehr):
//   upsert_controller_for / upsert_hydrometer_for / upsert_profile_for
//   insert_controller_telemetry_for / insert_hydrometer_telemetry_for (Batch-jsonb)
//   derive_brew_sessions_for (Aggregation serverseitig, strikt per owner)
//   last_telemetry_ts_for (Watermark, ersetzt direktes SELECT MAX)
// owner (uuid) kommt ausschließlich aus get_all_rapt_creds_for_sync()-Row — nie aus RAPT-Daten.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_INTERVAL_MS = Number(process.env.RAPT_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
const SYNC_ENABLED = process.env.RAPT_SYNC_ENABLED !== 'false';

const RAPT_TOKEN_ENDPOINT = process.env.RAPT_TOKEN_ENDPOINT ?? 'https://id.rapt.io/connect/token';
const RAPT_API_BASE = process.env.RAPT_API_BASE ?? 'https://api.rapt.io';
const RAPT_FETCH_TIMEOUT_MS = Number(process.env.RAPT_FETCH_TIMEOUT_MS ?? 15000);

let pool = null;
// Token-Cache pro owner-UUID (eindeutig im Multi-Tenant-Modell)
const tokenCacheByUser = new Map(); // owner uuid → {token, expiry}

function ready() {
  return Boolean(SYNC_ENABLED && DATABASE_URL);
}

function init() {
  if (!ready()) {
    console.log('[db-sync] disabled (RAPT_SYNC_ENABLED=false or missing DATABASE_URL)');
    return;
  }
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  pool.on('error', (err) => console.error('[db-sync] pg pool error:', err.message));

  // Start initial sync soon after boot, then schedule recurring runs.
  setTimeout(runSync, 5000);
  setInterval(runSync, SYNC_INTERVAL_MS);
  console.log(`[db-sync] enabled, interval=${SYNC_INTERVAL_MS}ms`);
}

// ---------------------------------------------------------------------------
// RAPT API access
// ---------------------------------------------------------------------------

async function getToken(owner, username, apiKey) {
  const now = Date.now();
  const cached = tokenCacheByUser.get(owner);
  if (cached && cached.expiry > now + 60000) return cached.token;

  const body = new URLSearchParams({
    client_id: 'rapt-user',
    grant_type: 'password',
    username,
    password: apiKey,
  });
  const resp = await fetch(RAPT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`RAPT auth failed for ${username}: ${data.error_description || resp.status}`);

  tokenCacheByUser.set(owner, {
    token: data.access_token,
    expiry: now + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

async function raptGet(token, path, params = {}) {
  const url = new URL(path, RAPT_API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(RAPT_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`RAPT ${path} failed: ${resp.status}`);
  return resp.json();
}

/// Lädt alle User-Profile mit RAPT-Credentials über die Service-RPC.
/// Die SECURITY DEFINER-Funktion entschlüsselt intern den Vault und gibt
/// nur konfigurierte User zurück. Kein Direktzugriff auf rapt.user_profiles.
/// Liefert Rows mit (owner uuid, rapt_user_id, rapt_api_key).
async function fetchActiveProfiles() {
  const res = await pool.query('SELECT * FROM rapt.get_all_rapt_creds_for_sync()');
  return res.rows;
}

// ---------------------------------------------------------------------------
// Upserts — alle über SECURITY DEFINER-RPCs (Phase 2)
// owner (uuid) wird pro gepolltem Konto aus up.owner gelesen und in jeden
// Schreibaufruf durchgereicht. Niemals aus RAPT-API-Daten ableiten.
// ---------------------------------------------------------------------------

async function upsertControllers(owner, items) {
  for (const c of items || []) {
    await pool.query(
      'SELECT rapt.upsert_controller_for($1, $2, $3, $4, $5::jsonb)',
      [owner, c.id, c.name || '(unnamed)', c.lastSeen || null, JSON.stringify(c)]
    );
  }
}

async function upsertHydrometers(owner, items) {
  for (const h of items || []) {
    await pool.query(
      'SELECT rapt.upsert_hydrometer_for($1, $2, $3, $4, $5::jsonb)',
      [owner, h.id, h.name || '(unnamed)', h.lastSeen || null, JSON.stringify(h)]
    );
  }
}

async function upsertProfiles(owner, items) {
  for (const p of items || []) {
    await pool.query(
      'SELECT rapt.upsert_profile_for($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
      [owner, p.id, p.name || '(unnamed)', !!p.deleted, !!p.public, p.createdOn || null, p.modifiedOn || null, JSON.stringify(p)]
    );
  }
}

// Batch-Insert via jsonb-Array — ein RPC-Roundtrip statt N Einzel-Inserts.
// Die RPC iteriert serverseitig und schreibt alle Rows mit ON CONFLICT DO NOTHING.
async function insertControllerTelemetry(owner, deviceId, rows) {
  if (!rows || rows.length === 0) return;
  await pool.query(
    'SELECT rapt.insert_controller_telemetry_for($1, $2, $3::jsonb)',
    [owner, deviceId, JSON.stringify(rows)]
  );
}

async function insertHydrometerTelemetry(owner, hydrometerId, rows) {
  if (!rows || rows.length === 0) return;
  await pool.query(
    'SELECT rapt.insert_hydrometer_telemetry_for($1, $2, $3::jsonb)',
    [owner, hydrometerId, JSON.stringify(rows)]
  );
}

// ---------------------------------------------------------------------------
// Watermark-Query — über SECURITY DEFINER-RPC (Phase 2)
// Ersetzt das direkte SELECT MAX(created_on) FROM rapt.telemetry_*,
// das nach Grant-Entzug (005) nicht mehr möglich ist.
// p_kind: 'controller' | 'hydrometer'
// ---------------------------------------------------------------------------

async function lastTelemetryTs(owner, kind, deviceId) {
  const res = await pool.query(
    'SELECT rapt.last_telemetry_ts_for($1, $2, $3) AS last',
    [owner, kind, deviceId]
  );
  return res.rows[0]?.last || null;
}

async function syncControllerTelemetry(token, owner, controllerId) {
  let inserted = 0;
  try {
    let last;
    try {
      last = await lastTelemetryTs(owner, 'controller', controllerId);
    } catch (e) {
      console.warn(`[db-sync] watermark controller ${controllerId} failed:`, e.message);
      return 0;
    }
    // Fix 4: defensive Date coercion — pg may return a string or Date
    const lastDate = last ? new Date(last) : null;
    const startDate = (lastDate ? new Date(lastDate.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
    const endDate = new Date().toISOString();
    const data = await raptGet(token, '/api/TemperatureControllers/GetTelemetry', {
      temperatureControllerId: controllerId,
      startDate,
      endDate,
    });
    const rows = Array.isArray(data) ? data : (data.rows || data.items || []);
    await insertControllerTelemetry(owner, controllerId, rows);
    inserted = rows.length;
  } catch (e) {
    console.warn(`[db-sync] controller telemetry ${controllerId} failed:`, e.message);
  }
  return inserted;
}

async function syncHydrometerTelemetry(token, owner, hydrometerId) {
  let inserted = 0;
  try {
    let last;
    try {
      last = await lastTelemetryTs(owner, 'hydrometer', hydrometerId);
    } catch (e) {
      console.warn(`[db-sync] watermark hydrometer ${hydrometerId} failed:`, e.message);
      return 0;
    }
    // Fix 4: defensive Date coercion — pg may return a string or Date
    const lastDate = last ? new Date(last) : null;
    const startDate = (lastDate ? new Date(lastDate.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
    const endDate = new Date().toISOString();
    const data = await raptGet(token, '/api/Hydrometers/GetTelemetry', {
      hydrometerId,
      startDate,
      endDate,
    });
    const rows = Array.isArray(data) ? data : (data.rows || data.items || []);
    await insertHydrometerTelemetry(owner, hydrometerId, rows);
    inserted = rows.length;
  } catch (e) {
    console.warn(`[db-sync] hydrometer telemetry ${hydrometerId} failed:`, e.message);
  }
  return inserted;
}

// Aggregation läuft jetzt vollständig serverseitig in der RPC, strikt auf owner gefiltert.
// Kein direkter SQL-Zugriff auf rapt.telemetry_controllers / rapt.brew_sessions mehr.
async function deriveBrewSessions(owner) {
  await pool.query(
    'SELECT rapt.derive_brew_sessions_for($1)',
    [owner]
  );
}

// ---------------------------------------------------------------------------
// Main sync orchestration
// ---------------------------------------------------------------------------

let syncRunning = false;
let lastSyncPaused = false; // tracks paused/active state for transition logging only

async function runSync() {
  if (syncRunning) {
    console.log('[db-sync] previous run still in progress, skipping');
    return;
  }
  syncRunning = true;
  const t0 = Date.now();
  try {
    let userProfiles;
    try {
      userProfiles = await fetchActiveProfiles();
    } catch (e) {
      console.error('[db-sync] fetch creds via RPC failed:', e.message);
      return;
    }
    if (userProfiles.length === 0) {
      if (!lastSyncPaused) {
        console.log('[db-sync] no RAPT creds returned by Service-RPC — sync paused');
        lastSyncPaused = true;
      }
      return;
    }
    if (lastSyncPaused) {
      console.log('[db-sync] RAPT creds found — sync resumed');
      lastSyncPaused = false;
    }

    let totalProfiles = 0, totalCtrl = 0, totalHydro = 0, totalCtrlT = 0, totalHydroT = 0;

    for (const up of userProfiles) {
      // owner (uuid) aus der vertrauenswürdigen Service-RPC-Row — niemals aus RAPT-Daten.
      const owner = up.owner;
      try {
        const token = await getToken(owner, up.rapt_user_id, up.rapt_api_key);
        const [profiles, controllers, hydrometers] = await Promise.all([
          raptGet(token, '/api/Profiles/GetProfiles'),
          raptGet(token, '/api/TemperatureControllers/GetTemperatureControllers'),
          raptGet(token, '/api/Hydrometers/GetHydrometers'),
        ]);
        await upsertProfiles(owner, profiles);
        await upsertControllers(owner, controllers);
        await upsertHydrometers(owner, hydrometers);
        let userCtrlT = 0;
        let userHydroT = 0;
        for (const c of controllers || []) userCtrlT += await syncControllerTelemetry(token, owner, c.id);
        for (const h of hydrometers || []) userHydroT += await syncHydrometerTelemetry(token, owner, h.id);
        totalCtrlT += userCtrlT;
        totalHydroT += userHydroT;
        // Fix 3: only run derive_brew_sessions_for when this user had telemetry this cycle
        if (userCtrlT + userHydroT > 0) {
          // derive_brew_sessions_for pro User innerhalb der Schleife — jeder owner bekommt
          // seine eigenen Sessions abgeleitet (serverseitig, strikt WHERE owner = p_owner).
          await deriveBrewSessions(owner);
        }
        totalProfiles += (profiles?.length || 0);
        totalCtrl += (controllers?.length || 0);
        totalHydro += (hydrometers?.length || 0);
      } catch (e) {
        console.warn(`[db-sync] user ${owner ?? '(unknown)'} sync failed:`, e.message);
      }
    }

    const dur = Date.now() - t0;
    console.log(`[db-sync] OK ${userProfiles.length} user(s) ${totalProfiles} profiles, ${totalCtrl} ctrl, ${totalHydro} hydro, +${totalCtrlT} ctrl-tele, +${totalHydroT} hydro-tele in ${dur}ms`);
  } catch (e) {
    console.error('[db-sync] failed:', e.message);
  } finally {
    syncRunning = false;
  }
}

function getPool() {
  return pool;
}

module.exports = { init, runSync, ready, getPool };

// Periodic worker: pollt RAPT API, persistiert in Supabase Postgres (rapt.* tables).
// - Stammdaten (controllers, hydrometers, profiles): UPSERT alle Sync-Zyklen
// - Telemetrie: incrementally (seit MAX(created_on) pro Gerät), INSERT ON CONFLICT DO NOTHING
// - brew_sessions: aggregiert aus telemetry_controllers (MIN/MAX created_on pro profile_id)
//   Custom-Dates vom User werden NICHT überschrieben.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_INTERVAL_MS = Number(process.env.RAPT_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
const SYNC_ENABLED = process.env.RAPT_SYNC_ENABLED !== 'false';

const RAPT_USERNAME = process.env.RAPT_USERNAME;
const RAPT_API_KEY = process.env.RAPT_API_KEY;
const RAPT_TOKEN_ENDPOINT = process.env.RAPT_TOKEN_ENDPOINT ?? 'https://id.rapt.io/connect/token';
const RAPT_API_BASE = process.env.RAPT_API_BASE ?? 'https://api.rapt.io';

let pool = null;
let tokenCache = null;
let tokenExpiry = 0;

function ready() {
  return Boolean(SYNC_ENABLED && DATABASE_URL && RAPT_USERNAME && RAPT_API_KEY);
}

function init() {
  if (!ready()) {
    console.log('[db-sync] disabled (missing DATABASE_URL or RAPT creds)');
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

async function getToken() {
  const now = Date.now();
  if (tokenCache && tokenExpiry > now + 60000) return tokenCache;

  const body = new URLSearchParams({
    client_id: 'rapt-user',
    grant_type: 'password',
    username: RAPT_USERNAME,
    password: RAPT_API_KEY,
  });
  const resp = await fetch(RAPT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`RAPT auth failed: ${data.error_description || resp.status}`);

  tokenCache = data.access_token;
  tokenExpiry = now + (data.expires_in || 3600) * 1000;
  return tokenCache;
}

async function raptGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(path, RAPT_API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`RAPT ${path} failed: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

async function upsertControllers(items) {
  for (const c of items || []) {
    await pool.query(
      `INSERT INTO rapt.controllers (rapt_id, name, last_seen, raw, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (rapt_id) DO UPDATE SET
         name = EXCLUDED.name,
         last_seen = EXCLUDED.last_seen,
         raw = EXCLUDED.raw,
         updated_at = now()`,
      [c.id, c.name || '(unnamed)', c.lastSeen || null, JSON.stringify(c)]
    );
  }
}

async function upsertHydrometers(items) {
  for (const h of items || []) {
    await pool.query(
      `INSERT INTO rapt.hydrometers (rapt_id, name, last_seen, raw, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (rapt_id) DO UPDATE SET
         name = EXCLUDED.name,
         last_seen = EXCLUDED.last_seen,
         raw = EXCLUDED.raw,
         updated_at = now()`,
      [h.id, h.name || '(unnamed)', h.lastSeen || null, JSON.stringify(h)]
    );
  }
}

async function upsertProfiles(items) {
  for (const p of items || []) {
    await pool.query(
      `INSERT INTO rapt.profiles (id, name, deleted, is_public, created_on, modified_on, raw, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         deleted = EXCLUDED.deleted,
         is_public = EXCLUDED.is_public,
         modified_on = EXCLUDED.modified_on,
         raw = EXCLUDED.raw,
         updated_at = now()`,
      [p.id, p.name || '(unnamed)', !!p.deleted, !!p.public, p.createdOn || null, p.modifiedOn || null, JSON.stringify(p)]
    );
  }
}

async function insertControllerTelemetry(deviceId, rows) {
  for (const r of rows || []) {
    await pool.query(
      `INSERT INTO rapt.telemetry_controllers (
         device_id, created_on, id, row_key, mac_address, rssi,
         control_device_type, control_device_mac_address, control_device_temperature,
         temperature, target_temperature, min_target_temperature, max_target_temperature,
         total_run_time, cooling_run_time, cooling_starts, heating_run_time, heating_starts,
         profile_id, profile_step_id, profile_session_start_date, profile_session_time, profile_step_progress,
         raw
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
       ) ON CONFLICT (device_id, created_on) DO NOTHING`,
      [
        deviceId,
        r.createdOn,
        r.id || null,
        r.rowKey || null,
        r.macAddress || null,
        r.rssi || null,
        r.controlDeviceType || null,
        r.controlDeviceMacAddress || null,
        r.controlDeviceTemperature || null,
        r.temperature || null,
        r.targetTemperature || null,
        r.minTargetTemperature || null,
        r.maxTargetTemperature || null,
        r.totalRunTime || null,
        r.coolingRunTime || null,
        r.coolingStarts || null,
        r.heatingRunTime || null,
        r.heatingStarts || null,
        r.profileId || null,
        r.profileStepId || null,
        r.profileSessionStartDate || null,
        r.profileSessionTime || null,
        r.profileStepProgress || null,
        JSON.stringify(r),
      ]
    );
  }
}

async function insertHydrometerTelemetry(hydrometerId, rows) {
  for (const r of rows || []) {
    await pool.query(
      `INSERT INTO rapt.telemetry_hydrometers (
         hydrometer_id, created_on, id, row_key, mac_address, rssi,
         temperature, gravity, gravity_velocity, battery, version, raw
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
       ) ON CONFLICT (hydrometer_id, created_on) DO NOTHING`,
      [
        hydrometerId,
        r.createdOn,
        r.id || null,
        r.rowKey || null,
        r.macAddress || null,
        r.rssi || null,
        r.temperature || null,
        r.gravity || null,
        r.gravityVelocity || null,
        r.battery || null,
        r.version || null,
        JSON.stringify(r),
      ]
    );
  }
}

async function lastTelemetryTs(table, idColumn, deviceId) {
  const res = await pool.query(
    `SELECT MAX(created_on) AS last FROM ${table} WHERE ${idColumn} = $1`,
    [deviceId]
  );
  return res.rows[0]?.last || null;
}

async function syncControllerTelemetry(controllerId) {
  const last = await lastTelemetryTs('rapt.telemetry_controllers', 'device_id', controllerId);
  const startDate = (last ? new Date(last.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
  const endDate = new Date().toISOString();
  let inserted = 0;
  try {
    const data = await raptGet('/api/TemperatureControllers/GetTelemetry', {
      temperatureControllerId: controllerId,
      startDate,
      endDate,
    });
    const rows = Array.isArray(data) ? data : (data.rows || data.items || []);
    await insertControllerTelemetry(controllerId, rows);
    inserted = rows.length;
  } catch (e) {
    console.warn(`[db-sync] controller telemetry ${controllerId} failed:`, e.message);
  }
  return inserted;
}

async function syncHydrometerTelemetry(hydrometerId) {
  const last = await lastTelemetryTs('rapt.telemetry_hydrometers', 'hydrometer_id', hydrometerId);
  const startDate = (last ? new Date(last.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
  const endDate = new Date().toISOString();
  let inserted = 0;
  try {
    const data = await raptGet('/api/Hydrometers/GetTelemetry', {
      hydrometerId,
      startDate,
      endDate,
    });
    const rows = Array.isArray(data) ? data : (data.rows || data.items || []);
    await insertHydrometerTelemetry(hydrometerId, rows);
    inserted = rows.length;
  } catch (e) {
    console.warn(`[db-sync] hydrometer telemetry ${hydrometerId} failed:`, e.message);
  }
  return inserted;
}

async function deriveBrewSessions() {
  // Aggregiert pro profile_id aus telemetry_controllers. Custom dates bleiben unangetastet.
  await pool.query(`
    INSERT INTO rapt.brew_sessions (profile_id, name, start_date, end_date, updated_at)
    SELECT
      t.profile_id,
      COALESCE(p.name, '(unbenannter Sud)'),
      MIN(t.created_on),
      MAX(t.created_on),
      now()
    FROM rapt.telemetry_controllers t
    LEFT JOIN rapt.profiles p ON p.id = t.profile_id
    WHERE t.profile_id IS NOT NULL
    GROUP BY t.profile_id, p.name
    ON CONFLICT (profile_id) DO UPDATE SET
      start_date = EXCLUDED.start_date,
      end_date   = EXCLUDED.end_date,
      name       = COALESCE(rapt.brew_sessions.name, EXCLUDED.name),
      updated_at = now();
  `);
}

// ---------------------------------------------------------------------------
// Main sync orchestration
// ---------------------------------------------------------------------------

let syncRunning = false;

async function runSync() {
  if (syncRunning) {
    console.log('[db-sync] previous run still in progress, skipping');
    return;
  }
  syncRunning = true;
  const t0 = Date.now();
  try {
    const [profiles, controllers, hydrometers] = await Promise.all([
      raptGet('/api/Profiles/GetProfiles'),
      raptGet('/api/TemperatureControllers/GetTemperatureControllers'),
      raptGet('/api/Hydrometers/GetHydrometers'),
    ]);
    await upsertProfiles(profiles);
    await upsertControllers(controllers);
    await upsertHydrometers(hydrometers);

    let cTotal = 0;
    let hTotal = 0;
    for (const c of controllers || []) cTotal += await syncControllerTelemetry(c.id);
    for (const h of hydrometers || []) hTotal += await syncHydrometerTelemetry(h.id);

    await deriveBrewSessions();

    const dur = Date.now() - t0;
    console.log(`[db-sync] OK ${profiles?.length || 0} profiles, ${controllers?.length || 0} ctrl, ${hydrometers?.length || 0} hydro, +${cTotal} ctrl-tele, +${hTotal} hydro-tele in ${dur}ms`);
  } catch (e) {
    console.error('[db-sync] failed:', e.message);
  } finally {
    syncRunning = false;
  }
}

module.exports = { init, runSync, ready };

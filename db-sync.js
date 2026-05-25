// Periodic worker: pollt RAPT API, persistiert in Supabase Postgres (rapt.* tables).
// - Stammdaten (controllers, hydrometers, profiles): UPSERT alle Sync-Zyklen
// - Telemetrie: incrementally (seit MAX(created_on) pro Gerät), INSERT ON CONFLICT DO NOTHING
// - brew_sessions: aggregiert aus telemetry_controllers (MIN/MAX created_on pro profile_id)
//   Custom-Dates vom User werden NICHT überschrieben.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_INTERVAL_MS = Number(process.env.RAPT_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
const SYNC_ENABLED = process.env.RAPT_SYNC_ENABLED !== 'false';

const RAPT_TOKEN_ENDPOINT = process.env.RAPT_TOKEN_ENDPOINT ?? 'https://id.rapt.io/connect/token';
const RAPT_API_BASE = process.env.RAPT_API_BASE ?? 'https://api.rapt.io';
const RAPT_FETCH_TIMEOUT_MS = Number(process.env.RAPT_FETCH_TIMEOUT_MS ?? 15000);

let pool = null;
// Token-Cache pro RAPT-Username (für multi-user später)
const tokenCacheByUser = new Map(); // username → {token, expiry}

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

async function getToken(username, apiKey) {
  const now = Date.now();
  const cached = tokenCacheByUser.get(username);
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

  tokenCacheByUser.set(username, {
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
async function fetchActiveProfiles() {
  const res = await pool.query('SELECT * FROM rapt.get_all_rapt_creds_for_sync()');
  return res.rows;
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

// Allowlist of permitted {table, idColumn} combinations for lastTelemetryTs.
// pg cannot parameterise SQL identifiers, so we guard them explicitly.
const TELEMETRY_IDENTIFIER_ALLOWLIST = new Set([
  'rapt.telemetry_controllers|device_id',
  'rapt.telemetry_hydrometers|hydrometer_id',
]);

async function lastTelemetryTs(table, idColumn, deviceId) {
  const key = `${table}|${idColumn}`;
  if (!TELEMETRY_IDENTIFIER_ALLOWLIST.has(key)) {
    throw new Error(`lastTelemetryTs: disallowed identifier combination: ${key}`);
  }
  const res = await pool.query(
    `SELECT MAX(created_on) AS last FROM ${table} WHERE ${idColumn} = $1`,
    [deviceId]
  );
  return res.rows[0]?.last || null;
}

async function syncControllerTelemetry(token, controllerId) {
  const last = await lastTelemetryTs('rapt.telemetry_controllers', 'device_id', controllerId);
  const startDate = (last ? new Date(last.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
  const endDate = new Date().toISOString();
  let inserted = 0;
  try {
    const data = await raptGet(token, '/api/TemperatureControllers/GetTelemetry', {
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

async function syncHydrometerTelemetry(token, hydrometerId) {
  const last = await lastTelemetryTs('rapt.telemetry_hydrometers', 'hydrometer_id', hydrometerId);
  const startDate = (last ? new Date(last.getTime() + 1000) : new Date('2010-01-01T00:00:00Z')).toISOString();
  const endDate = new Date().toISOString();
  let inserted = 0;
  try {
    const data = await raptGet(token, '/api/Hydrometers/GetTelemetry', {
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
  // Telemetrie per profile_id split bei Lücken >7 Tage → mehrere Sessions pro Profile.
  // Match auf existierende brew_sessions per (profile_id, start_date ±1 Tag).
  // is_manual=true und custom_*_date werden NIE angefasst.
  const detected = await pool.query(`
    WITH ordered AS (
      SELECT created_on, profile_id,
             LAG(created_on) OVER (PARTITION BY profile_id ORDER BY created_on) AS prev
      FROM rapt.telemetry_controllers
      WHERE profile_id IS NOT NULL
    ),
    marked AS (
      SELECT created_on, profile_id,
        SUM(CASE WHEN prev IS NULL OR created_on - prev > INTERVAL '7 days' THEN 1 ELSE 0 END)
          OVER (PARTITION BY profile_id ORDER BY created_on) AS sess_n
      FROM ordered
    )
    SELECT profile_id, sess_n AS session_index,
           MIN(created_on) AS first_seen,
           MAX(created_on) AS last_seen
    FROM marked
    GROUP BY profile_id, sess_n
  `);

  let inserted = 0, updated = 0;
  for (const s of detected.rows) {
    const match = await pool.query(
      `SELECT id FROM rapt.brew_sessions
       WHERE profile_id = $1
         AND ABS(EXTRACT(EPOCH FROM (start_date - $2::timestamptz))) < 86400
       LIMIT 1`,
      [s.profile_id, s.first_seen]
    );
    if (match.rows.length > 0) {
      const r = await pool.query(
        `UPDATE rapt.brew_sessions
         SET end_date = $1, updated_at = now()
         WHERE id = $2 AND NOT is_manual AND end_date <> $1`,
        [s.last_seen, match.rows[0].id]
      );
      updated += r.rowCount;
    } else {
      await pool.query(
        `INSERT INTO rapt.brew_sessions (profile_id, name, start_date, end_date, is_manual)
         VALUES ($1,
                 COALESCE((SELECT name FROM rapt.profiles WHERE id = $1), '(unbenannter Sud)'),
                 $2, $3, false)`,
        [s.profile_id, s.first_seen, s.last_seen]
      );
      inserted++;
    }
  }
  if (inserted + updated > 0) {
    console.log(`[db-sync] brew_sessions: +${inserted} new, ${updated} updated`);
  }
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
      try {
        const token = await getToken(up.rapt_user_id, up.rapt_api_key);
        const [profiles, controllers, hydrometers] = await Promise.all([
          raptGet(token, '/api/Profiles/GetProfiles'),
          raptGet(token, '/api/TemperatureControllers/GetTemperatureControllers'),
          raptGet(token, '/api/Hydrometers/GetHydrometers'),
        ]);
        await upsertProfiles(profiles);
        await upsertControllers(controllers);
        await upsertHydrometers(hydrometers);
        for (const c of controllers || []) totalCtrlT += await syncControllerTelemetry(token, c.id);
        for (const h of hydrometers || []) totalHydroT += await syncHydrometerTelemetry(token, h.id);
        totalProfiles += (profiles?.length || 0);
        totalCtrl += (controllers?.length || 0);
        totalHydro += (hydrometers?.length || 0);
      } catch (e) {
        console.warn(`[db-sync] user ${up.owner ?? '(unknown)'} sync failed:`, e.message);
      }
    }

    await deriveBrewSessions();

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

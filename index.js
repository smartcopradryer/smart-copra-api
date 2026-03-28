require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');

const app = express();

// ===============================
// DATABASE
// ===============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('connect', () => {
  console.log('[DB] PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected PostgreSQL error:', err);
});

// ===============================
// MIDDLEWARE
// ===============================
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ===============================
// ROUTES
// ===============================
app.get('/', async (req, res) => {
  res.json({
    success: true,
    message: 'Smart Copra Dryer API is running',
  });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      success: true,
      message: 'OK',
      serverTime: result.rows[0].now,
    });
  } catch (error) {
    console.error('[GET /health] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: error.message,
    });
  }
});

app.post('/api/telemetry', async (req, res) => {
  const client = await pool.connect();

  try {
    const payload = req.body;

    if (!payload.deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required',
      });
    }

    const {
      deviceId,
      event = 'HEARTBEAT',
      temp = null,
      status = 'IDLE',
      overheat = false,
      session = null,
    } = payload;

    await client.query('BEGIN');

    const upsertDeviceQuery = `
      INSERT INTO dbo.devices (
        device_id,
        latest_temp,
        latest_status,
        overheat,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
      ON CONFLICT (device_id)
      DO UPDATE SET
        latest_temp = EXCLUDED.latest_temp,
        latest_status = EXCLUDED.latest_status,
        overheat = EXCLUDED.overheat,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING *;
    `;

    const deviceResult = await client.query(upsertDeviceQuery, [
      deviceId,
      temp,
      status,
      overheat,
    ]);

    const insertLogQuery = `
      INSERT INTO dbo.telemetry_logs (
        device_id,
        event,
        temp,
        status,
        overheat,
        session_active,
        session_duration_ms,
        session_remaining_ms,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *;
    `;

    const logResult = await client.query(insertLogQuery, [
      deviceId,
      event,
      temp,
      status,
      overheat,
      session ? !!session.active : null,
      session ? session.durationMs ?? null : null,
      session ? session.remainingMs ?? null : null,
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Telemetry saved successfully',
      data: {
        device: deviceResult.rows[0],
        log: logResult.rows[0],
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[POST /api/telemetry] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  } finally {
    client.release();
  }
});

app.get('/api/devices/:deviceId/latest', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM dbo.devices
      WHERE device_id = $1
      LIMIT 1;
      `,
      [deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found',
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('[GET latest] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

app.get('/api/devices/:deviceId/history', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = Number(req.query.limit || 50);

    const result = await pool.query(
      `
      SELECT *
      FROM dbo.telemetry_logs
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [deviceId, limit]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('[GET history] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM dbo.devices
      ORDER BY updated_at DESC;
    `);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('[GET dbo.devices] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 100);

    const result = await pool.query(
      `
      SELECT *
      FROM dbo.telemetry_logs
      ORDER BY created_at DESC
      LIMIT $1;
      `,
      [limit]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('[GET logs] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Local only
if (process.env.VERCEL !== '1') {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`[BOOT] Server running on http://localhost:${PORT}`);
  });
}

// Vercel function export
module.exports = app;
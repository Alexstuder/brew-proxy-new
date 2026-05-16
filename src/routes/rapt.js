const express = require('express');
const axios = require('axios');
const router = express.Router();

let cachedData = null;
let lastFetch = 0;
const CACHE_MS = 30000; // 30 Sekunden Cache

async function getRaptToken() {
  const res = await axios.post('https://id.rapt.io/connect/token', new URLSearchParams({
    client_id: 'rapt-user',
    grant_type: 'password',
    username: process.env.RAPT_EMAIL,
    password: process.env.RAPT_PASSWORD,
  }));
  return res.data.access_token;
}

router.get('/latest', async (req, res) => {
  try {
    if (cachedData && Date.now() - lastFetch < CACHE_MS) {
      return res.json(cachedData);
    }
    const token = await getRaptToken();
    const devices = await axios.get('https://api.rapt.io/api/Hydrometers/GetHydrometers', {
      headers: { Authorization: `Bearer ${token}` }
    });
    cachedData = devices.data[0] || {};
    lastFetch = Date.now();
    res.json(cachedData);
  } catch (e) {
    res.status(500).json({ error: 'RAPT API Fehler', detail: e.message });
  }
});

module.exports = router;

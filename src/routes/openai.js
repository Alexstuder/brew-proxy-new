const express = require('express');
const axios = require('axios');
const router = express.Router();

router.post('/rezept', async (req, res) => {
  try {
    const { prompt } = req.body;
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Du bist ein erfahrener Hobbybrauer und hilfst beim Erstellen von Bierrezepten.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1000,
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    res.json({ rezept: response.data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: 'OpenAI Fehler', detail: e.message });
  }
});

module.exports = router;

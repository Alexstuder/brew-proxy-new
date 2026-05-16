require('dotenv').config();
const express = require('express');
const cors = require('cors');
const raptRouter = require('./routes/rapt');
const openaiRouter = require('./routes/openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/rapt', raptRouter);
app.use('/api/openai', openaiRouter);

app.listen(PORT, () => {
  console.log(`brew-proxy läuft auf Port ${PORT}`);
});

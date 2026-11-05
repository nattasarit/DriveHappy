'use strict';

try {
  require('dotenv').config();
} catch {
  // dotenv optional if Hostinger injects env
}

const path = require('path');
const express = require('express');
const { config } = require('./src/config');
const vehicleRoutes = require('./src/routes/vehicle');
const widgetRoutes = require('./src/routes/widgets');
const youtubeRoutes = require('./src/routes/youtube');
const teslaAuthRoutes = require('./src/routes/teslaAuth');
const { getUsage } = require('./src/tesla/client');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'DriveHappy',
    domain: 'hd.bkksoftkit.com',
    node: process.version,
    teslaUsage: getUsage(),
    policy: { neverWake: true, neverCommand: true },
  });
});

app.use('/api/vehicle', vehicleRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/tesla', teslaAuthRoutes);

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: config.nodeEnv === 'production' ? '1h' : 0,
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Internal error' });
});

const port = config.port;
app.listen(port, () => {
  console.log(`DriveHappy listening on PORT=${port} (never wake / never command)`);
});

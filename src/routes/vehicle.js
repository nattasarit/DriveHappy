'use strict';

const express = require('express');
const { getDashboardVehicle } = require('../tesla/vehicle');
const { getUsage } = require('../tesla/client');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const data = await getDashboardVehicle();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(err.status && err.status < 500 ? err.status : 502).json({
      ok: false,
      error: err.message,
      usage: getUsage(),
    });
  }
});

router.get('/usage', (_req, res) => {
  res.json({ ok: true, data: getUsage() });
});

module.exports = router;

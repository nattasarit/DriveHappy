'use strict';

const { config } = require('../config');
const { cache } = require('../cache');
const { teslaGet, getUsage, softLimitReached } = require('./client');

function configured() {
  return Boolean(
    config.tesla.clientId &&
      (config.tesla.refreshToken || config.tesla.accessToken) &&
      config.tesla.vin
  );
}

function pickSnapshot(vehicleData) {
  const r = vehicleData?.response || vehicleData || {};
  const charge = r.charge_state || {};
  const climate = r.climate_state || {};
  const vehicle = r.vehicle_state || {};
  return {
    batteryLevel: charge.battery_level ?? null,
    batteryRangeKm: charge.battery_range != null ? Number((charge.battery_range * 1.60934).toFixed(1)) : null,
    estBatteryRangeKm:
      charge.est_battery_range != null ? Number((charge.est_battery_range * 1.60934).toFixed(1)) : null,
    chargingState: charge.charging_state ?? null,
    chargeLimitSoc: charge.charge_limit_soc ?? null,
    insideTempC: climate.inside_temp ?? null,
    outsideTempC: climate.outside_temp ?? null,
    locked: vehicle.locked ?? null,
    odometerKm: vehicle.odometer != null ? Number((vehicle.odometer * 1.60934).toFixed(1)) : null,
    carVersion: vehicle.car_version ?? null,
    timestamps: {
      charge: charge.timestamp ?? null,
      climate: climate.timestamp ?? null,
      vehicle: vehicle.timestamp ?? null,
    },
  };
}

async function fetchVehiclesList() {
  const json = await teslaGet('/api/1/vehicles');
  const list = json?.response || [];
  return list.map((v) => ({
    id: v.id,
    vehicleId: v.vehicle_id,
    vin: v.vin,
    displayName: v.display_name || v.vin,
    state: v.state,
    inService: v.in_service,
  }));
}

async function fetchCachedVehicleData(vin) {
  const json = await teslaGet(`/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data_cached`);
  return {
    source: 'vehicle_data_cached',
    rawPresent: true,
    snapshot: pickSnapshot(json),
  };
}

async function fetchLiveVehicleData(vin) {
  // Live poll only — NEVER wake. Caller must ensure vehicle is already online.
  const json = await teslaGet(`/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`);
  return {
    source: 'vehicle_data',
    rawPresent: true,
    snapshot: pickSnapshot(json),
  };
}

async function getDashboardVehicle() {
  if (!configured()) {
    return {
      configured: false,
      message: 'ตั้งค่า TESLA_CLIENT_ID และ TESLA_REFRESH_TOKEN ใน Hostinger ก่อน',
      usage: getUsage(),
    };
  }

  if (softLimitReached()) {
    const stale = cache.get(`vehicle:${config.tesla.vin}`);
    return {
      configured: true,
      softLimited: true,
      message: 'หยุดเรียก Tesla ชั่วคราวเพื่อคุมงบ ~$10/เดือน — ใช้ข้อมูลแคชล่าสุด',
      usage: getUsage(),
      ...(stale ? { ...stale.value, cached: true, storedAt: stale.storedAt } : {}),
    };
  }

  const vin = config.tesla.vin;

  const listResult = await cache.getOrFetch('vehicles:list', config.ttl.vehiclesList, fetchVehiclesList);
  const match = (listResult.data || []).find((v) => v.vin === vin) || (listResult.data || [])[0] || null;
  const state = match?.state || 'unknown';

  let dataResult;
  let usedLive = false;
  try {
    dataResult = await cache.getOrFetch(
      `vehicle:cached:${vin}`,
      config.ttl.vehicle,
      () => fetchCachedVehicleData(vin)
    );
  } catch (err) {
    // 404/412 = cached unsupported — still never wake
    if (err.status === 404 || err.status === 412) {
      dataResult = {
        data: {
          source: 'unavailable',
          rawPresent: false,
          snapshot: {},
          note: `vehicle_data_cached returned ${err.status}`,
        },
        cached: false,
        storedAt: Date.now(),
        ageMs: 0,
      };
    } else {
      throw err;
    }
  }

  if (
    config.tesla.allowLiveIfOnline &&
    state === 'online' &&
    !softLimitReached()
  ) {
    try {
      const live = await cache.getOrFetch(
        `vehicle:live:${vin}`,
        config.ttl.liveVehicle,
        () => fetchLiveVehicleData(vin)
      );
      dataResult = live;
      usedLive = true;
    } catch {
      // Keep cached snapshot — never wake to recover
    }
  }

  const payload = {
    configured: true,
    vin,
    displayName: match?.displayName || 'Tesla',
    state,
    usedLive,
    neverWake: true,
    neverCommand: true,
    source: dataResult.data.source,
    snapshot: dataResult.data.snapshot,
    note: dataResult.data.note || null,
    cached: dataResult.cached,
    stale: Boolean(dataResult.stale),
    storedAt: dataResult.storedAt,
    ageMs: dataResult.ageMs,
    usage: getUsage(),
  };

  cache.set(`vehicle:${vin}`, payload, config.ttl.vehicle);
  return payload;
}

module.exports = {
  getDashboardVehicle,
  configured,
  pickSnapshot,
};

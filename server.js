// server.js
const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

// ===== Config (override via ENV) =====
const ACCOMMODATION_ID = process.env.ACCOMMODATION_ID
  || '5edbae02-da8e-4489-8349-4bb836450b3e'; // <-- this is the one from your working browser call
const DESTINATION = process.env.FERATEL_DESTINATION || 'accbludenz';
const PREFIX      = process.env.FERATEL_PREFIX      || 'BLU';
const BASE = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}`;

// If you really need a static fallback list, keep it here (should belong to THIS accommodation!)
const VERIFIED_PRODUCT_IDS = [
  'b4265783-9c09-44e0-9af1-63ad964d64b9',
  'bda33d85-729b-40ca-ba2b-de4ca5e5841b',
  '78f0ede7-ce03-4806-8556-0d627bff27de',
  'bdd9a73d-7429-4610-9347-168b4b2785d8',
  '980db5a5-ac66-49f3-811f-0da67cc4a972',
  '0d0ae603-3fd9-4abd-98e8-eea813fd2d89'
];

// ===== Helpers =====
const toDate = s => new Date(s + 'T00:00:00Z');
const numberOrZero = v => (typeof v === 'number' && isFinite(v) ? v : 0);
const isDummyUUID = id => /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id || '');

function serializeAges(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const clean = arr.map(x => Number(x)).filter(n => Number.isFinite(n) && n >= 0);
  return clean.length ? clean.join(',') : '';
}

function makeHeaders(sessionId) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com/',
    // critical Feratel headers:
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': sessionId
  };
}

function pluckArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  // best effort
  for (const k of Object.keys(data)) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

function matrixIsUsable(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const r0 = rows[0];
  if (!r0?.productId || isDummyUUID(r0.productId)) return false;
  const hasAnyData = rows.some(r => r?.data && Object.keys(r.data).length > 0);
  return hasAnyData;
}

function addUpRow(row) {
  // row.data is an object whose keys are small integers (3,4,5,...), values are arrays of day entries
  // day entry: { date: "...", price: number, bookableStatus: 0|1|... , additionalServices?: [] }
  let total = 0;
  let countNights = 0;

  if (!row?.data || typeof row.data !== 'object') return { total, countNights };

  for (const bucket of Object.keys(row.data)) {
    const list = Array.isArray(row.data[bucket]) ? row.data[bucket] : [];
    for (const e of list) {
      const p = numberOrZero(e?.price);
      // Feratel uses -1 for not available; ignore negatives and zeros
      if (p > 0) {
        total += p;
        countNights += 1;
      }
      // optional extras
      if (Array.isArray(e?.additionalServices)) {
        for (const s of e.additionalServices) {
          const sp = numberOrZero(s?.price);
          if (sp > 0) total += sp;
        }
      }
    }
  }
  return { total, countNights };
}

// ===== Feratel calls =====
async function createSearch({ arrival, departure, units, adults, childrenAges, headers }) {
  const payload = {
    searchObject: {
      searchGeneral: {
        dateFrom: `${arrival}T00:00:00.000`,
        dateTo:   `${departure}T00:00:00.000`
      },
      searchAccommodation: {
        searchLines: [
          {
            units,
            adults,
            children: Array.isArray(childrenAges) ? childrenAges.length : 0,
            childrenAges: serializeAges(childrenAges) // "" or "8,12"
          }
        ]
      }
    }
  };
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, {
    headers, validateStatus: () => true
  });
  return { status: resp.status, id: resp.data?.id || null, payload, raw: resp.data };
}

async function tryFetchNames(headers, searchId) {
  // purely best-effort to get product names; price works without this
  const url = `${BASE}/services?fields=${encodeURIComponent('id,name')}&currency=EUR&searchId=${encodeURIComponent(searchId)}`;
  const resp = await axios.get(url, { headers, validateStatus: () => true });
  const items = pluckArray(resp.data).map(x => ({ id: x?.id, name: x?.name || '' })).filter(x => x.id);
  return { status: resp.status, items, url };
}

async function priceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges }) {
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges: serializeAges(childrenAges), // "" or "8,12"
    mealCode: "",
    currency: "EUR",
    nightsRange: ranges?.nightsRange ?? 1,
    arrivalRange: ranges?.arrivalRange ?? 1
  };
  const url = `${BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });
  return { status: resp.status, url, payload, data: resp.data };
}

// ===== Route =====
app.post('/get-price', async (req, res) => {
  const {
    arrival, departure,
    adults = 2, units = 1,
    children = [],
    productIds: overrideProductIds,
    ranges = { arrivalRange: 1, nightsRange: 1 },
    dwSessionId // optional: reuse session from browser
  } = req.body || {};

  if (!arrival || !departure) return res.status(400).json({ error: 'Missing arrival or departure date' });

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24*60*60*1000));
  if (nights <= 0) return res.status(400).json({ error: 'Departure date must be after arrival date' });

  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 0);

  const sessionId = dwSessionId || `P${Date.now()}`; // mirrors the P######### style you posted
  const headers = makeHeaders(sessionId);

  const debug = {
    accommodationId: ACCOMMODATION_ID,
    baseUrl: BASE,
    sessionId,
    input: { arrival, departure, units, adults, childrenAges, nights },
    steps: []
  };

  try {
    // 1) create search
    const s = await createSearch({ arrival, departure, units, adults, childrenAges, headers });
    debug.steps.push({ step: 'createSearch', status: s.status, searchId: s.id, headersUsed: 'dwapp-accommodation', searchPayload: s.payload });
    if (!s.id) return res.status(502).json({ error: 'Failed to initiate search', debug });

    // 2) product ids & optional names
    let productIds = Array.isArray(overrideProductIds) && overrideProductIds.length
      ? overrideProductIds.slice()
      : VERIFIED_PRODUCT_IDS.slice();

    // best-effort: attach names if the services endpoint answers
    const names = new Map();
    const namesResp = await tryFetchNames(headers, s.id);
    debug.steps.push({ step: 'fetchNames', status: namesResp.status, url: namesResp.url, count: namesResp.items.length });
    for (const it of namesResp.items) if (it?.id) names.set(it.id, it.name || '');

    // 3) price matrix (UI-style ranges first)
    let pm = await priceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges });
    debug.steps.push({ step: 'pricematrix', status: pm.status, url: pm.url, payload: pm.payload, preview: Array.isArray(pm.data) ? pm.data.slice(0,1) : pm.data });

    if (!(pm.status >= 200 && pm.status < 300 && matrixIsUsable(pm.data))) {
      // retry stricter ranges 0/0
      const strict = { arrivalRange: 0, nightsRange: 0 };
      pm = await priceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges: strict });
      debug.steps.push({ step: 'pricematrix-retry-0-0', status: pm.status, payload: pm.payload, preview: Array.isArray(pm.data) ? pm.data.slice(0,1) : pm.data });

      if (!(pm.status >= 200 && pm.status < 300 && matrixIsUsable(pm.data))) {
        return res.status(502).json({ error: 'Price matrix returned no usable rows', debug });
      }
    }

    // 4) total per product
    const rows = Array.isArray(pm.data) ? pm.data : [];
    const totals = new Map();
    for (const row of rows) {
      const pid = row?.productId;
      if (!pid || isDummyUUID(pid)) continue;
      const { total, countNights } = addUpRow(row);
      totals.set(pid, { total, countNights });
    }

    const offers = productIds.map(pid => {
      const t = totals.get(pid) || { total: 0, countNights: 0 };
      return {
        productId: pid,
        name: names.get(pid) || '',
        totalPrice: t.total,
        currency: 'EUR',
        availability: t.total > 0 && t.countNights >= nights,
        nights
      };
    });

    return res.json({ offers, debug });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('Feratel API ERROR:', details);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details, debug });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`🏨 Destination: ${DESTINATION} / ${PREFIX}`);
  console.log(`📍 Accommodation: ${ACCOMMODATION_ID}`);
});

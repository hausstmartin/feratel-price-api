// server.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===== Config =====
const ACCOMMODATION_ID = process.env.ACCOMMODATION_ID
  || '5edbae02-da8e-4489-8349-4bb836450b3e';
const DESTINATION = process.env.FERATEL_DESTINATION || 'accbludenz';
const PREFIX = process.env.FERATEL_PREFIX || 'BLU';
const BASE = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}`;

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
const serializeAges = arr => {
  if (!Array.isArray(arr) || !arr.length) return '';
  const clean = arr.map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return clean.length ? clean.join(',') : '';
};
const makeHeaders = sessionId => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0',
  'Origin': 'https://direct.bookingandmore.com',
  'Referer': 'https://direct.bookingandmore.com/',
  'DW-Source': 'dwapp-accommodation',
  'DW-SessionId': sessionId
});
const pluckArray = data => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
};
const isDummyUUID = id => /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id || '');

// ===== Feratel calls =====
async function createSearch({ arrival, departure, units, adults, childrenAges, headers }) {
  const payload = {
    searchObject: {
      searchGeneral: {
        dateFrom: `${arrival}T00:00:00.000`,
        dateTo: `${departure}T00:00:00.000`
      },
      searchAccommodation: {
        searchLines: [{
          units,
          adults,
          children: childrenAges.length,
          childrenAges: serializeAges(childrenAges)
        }]
      }
    }
  };
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers });
  return { status: resp.status, id: resp.data?.id || null, payload };
}

async function tryFetchNames(headers, searchId) {
  const url = `${BASE}/services?fields=${encodeURIComponent('id,name')}&currency=EUR&searchId=${encodeURIComponent(searchId)}`;
  const resp = await axios.get(url, { headers });
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
    childrenAges: serializeAges(childrenAges),
    mealCode: "",
    currency: "EUR",
    nightsRange: ranges?.nightsRange ?? 1,
    arrivalRange: ranges?.arrivalRange ?? 1
  };
  const url = `${BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers });
  return { status: resp.status, url, payload, data: resp.data };
}

// ===== New price extraction =====
function extractTotalPrice(row, nights, arrival) {
  if (!row?.data || typeof row.data !== 'object') return 0;
  const bucket = row.data[nights];
  if (!Array.isArray(bucket)) return 0;
  const found = bucket.find(e => e?.date?.startsWith(arrival));
  return found?.price > 0 ? found.price : 0;
}

// ===== Route =====
app.post('/get-price', async (req, res) => {
  const {
    arrival, departure,
    adults = 2, units = 1,
    children = [],
    productIds: overrideProductIds,
    ranges = { arrivalRange: 1, nightsRange: 1 },
    dwSessionId
  } = req.body || {};

  if (!arrival || !departure) return res.status(400).json({ error: 'Missing arrival or departure date' });

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
  if (nights <= 0) return res.status(400).json({ error: 'Departure date must be after arrival date' });

  const childrenAges = (Array.isArray(children) ? children : []).map(Number).filter(n => Number.isFinite(n) && n >= 0);

  const sessionId = dwSessionId || `P${Date.now()}`;
  const headers = makeHeaders(sessionId);

  const debug = {
    accommodationId: ACCOMMODATION_ID,
    baseUrl: BASE,
    sessionId,
    input: { arrival, departure, units, adults, childrenAges, nights },
    steps: []
  };

  try {
    const s = await createSearch({ arrival, departure, units, adults, childrenAges, headers });
    debug.steps.push({ step: 'createSearch', status: s.status, searchId: s.id, searchPayload: s.payload });
    if (!s.id) return res.status(502).json({ error: 'Failed to initiate search', debug });

    let productIds = Array.isArray(overrideProductIds) && overrideProductIds.length
      ? overrideProductIds.slice()
      : VERIFIED_PRODUCT_IDS.slice();

    const namesResp = await tryFetchNames(headers, s.id);
    debug.steps.push({ step: 'fetchNames', status: namesResp.status, count: namesResp.items.length });
    const namesMap = new Map(namesResp.items.map(i => [i.id, i.name]));

    let pm = await priceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges });
    debug.steps.push({ step: 'pricematrix', status: pm.status });

    if (!(pm.status >= 200 && pm.status < 300 && Array.isArray(pm.data))) {
      const strict = { arrivalRange: 0, nightsRange: 0 };
      pm = await priceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges: strict });
      debug.steps.push({ step: 'pricematrix-retry', status: pm.status });
      if (!(pm.status >= 200 && pm.status < 300 && Array.isArray(pm.data))) {
        return res.status(502).json({ error: 'Price matrix returned no usable rows', debug });
      }
    }

    const offers = productIds.map(pid => {
      const row = pm.data.find(r => r?.productId === pid);
      const totalPrice = extractTotalPrice(row, nights, arrival);
      return {
        productId: pid,
        name: namesMap.get(pid) || '',
        totalPrice,
        currency: 'EUR',
        availability: totalPrice > 0,
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
});

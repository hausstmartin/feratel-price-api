// server.js
// Feratel "price per stay" API — exact stay price for given arrival + nights

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===================== CONFIG =====================
const DESTINATION = process.env.FERATEL_DESTINATION || 'accbludenz';
const PREFIX      = process.env.FERATEL_PREFIX      || 'BLU';
const ACCOMMODATION_ID =
  process.env.ACCOMMODATION_ID || '5edbae02-da8e-4489-8349-4bb836450b3e'; // tvoje ověřené

const BASE = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}`;

// Pokud volající neposílá productIds, použijeme tyhle ověřené pro tohle ubytování:
const DEFAULT_PRODUCT_IDS = [
  'b4265783-9c09-44e0-9af1-63ad964d64b9', // Room 1 - Twin room, shared shower/shared toilet
  'bda33d85-729b-40ca-ba2b-de4ca5e5841b', // Room 2 - Family room, bath hallway, toilet
  '78f0ede7-ce03-4806-8556-0d627bff27de', // Room 3 - Double room, bath, toilet
  'bdd9a73d-7429-4610-9347-168b4b2785d8', // Double room, bath, toilet  (často -1 = not bookable)
  '980db5a5-ac66-49f3-811f-0da67cc4a972', // Room 5 - Double room, shared shower/shared toilet
  '0d0ae603-3fd9-4abd-98e8-eea813fd2d89', // Room 6 - Double room, shared shower/shared toilet
];

// ===================== HELPERS =====================
const toDate = (s) => new Date(s + 'T00:00:00Z');

const serializeAges = (arr) => {
  if (!Array.isArray(arr) || !arr.length) return '';
  const clean = arr.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return clean.length ? clean.join(',') : '';
};

const makeHeaders = (dwSessionId) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  Origin: 'https://direct.bookingandmore.com',
  Referer: 'https://direct.bookingandmore.com/',
  // Feratel vyžaduje:
  'DW-Source': 'dwapp-accommodation',
  'DW-SessionId': dwSessionId || `P${Date.now()}`,
});

// zkus vrátit první pole z odpovědi (Feratel má různé tvary)
function pluckArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of Object.keys(data)) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

const isDummyUUID = (id) => /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id || '');

// Vyber cenu přesně z pásma "nights"
function selectStayPriceFromRow(row, arrival, nights) {
  if (!row?.data || typeof row.data !== 'object') return { price: 0, picked: null };

  const key = String(nights);
  const list = Array.isArray(row.data[key]) ? row.data[key] : [];

  if (!list.length) return { price: 0, picked: null };

  // preferuj záznam s přesným datem příjezdu
  const arrivalIso = `${arrival}T00:00:00`;
  let picked = list.find((e) => e?.date === arrivalIso && typeof e?.price === 'number');

  // když přesná shoda není, vezmi první validní (Feratel může vracet okno podle arrivalRange)
  if (!picked) picked = list.find((e) => typeof e?.price === 'number');

  // -1 znamená not available
  const price = picked && picked.price > 0 ? picked.price : 0;
  return { price, picked };
}

// bezpečná suma případných "additionalServices"
function additionalServicesTotal(entry) {
  if (!Array.isArray(entry?.additionalServices)) return 0;
  let sum = 0;
  for (const s of entry.additionalServices) {
    const p = Number(s?.price);
    if (Number.isFinite(p) && p > 0) sum += p;
  }
  return sum;
}

// ===================== FERATEL CALLS =====================
async function createSearch({ arrival, departure, units, adults, childrenAges, headers }) {
  const payload = {
    searchObject: {
      searchGeneral: {
        dateFrom: `${arrival}T00:00:00.000`,
        dateTo: `${departure}T00:00:00.000`,
      },
      searchAccommodation: {
        searchLines: [
          {
            units,
            adults,
            children: Array.isArray(childrenAges) ? childrenAges.length : 0,
            childrenAges: serializeAges(childrenAges),
          },
        ],
      },
    },
  };

  const resp = await axios.post('https://webapi.deskline.net/searches', payload, {
    headers,
    validateStatus: () => true,
  });

  return { status: resp.status, id: resp.data?.id || null, payload, raw: resp.data };
}

// Preferovaný způsob: jednoduché `id,name` ze services
async function tryFetchNamesViaServices(headers, searchId) {
  const url = `${BASE}/services?fields=${encodeURIComponent('id,name')}&currency=EUR&searchId=${encodeURIComponent(
    searchId
  )}&pageNo=1&pageSize=32767`;
  const resp = await axios.get(url, { headers, validateStatus: () => true });
  const items = pluckArray(resp.data)
    .map((x) => ({ id: x?.id, name: x?.name || '' }))
    .filter((x) => x.id);
  return { status: resp.status, items, url };
}

// Fallback: naber id→name z detailu ubytování (products{id,name})
async function tryFetchNamesViaAccommodation(headers) {
  const fields = 'products{id,name}';
  const url = `${BASE}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=32767`;
  const resp = await axios.get(url, { headers, validateStatus: () => true });
  const items = [];
  const list = pluckArray(resp.data);
  for (const block of list) {
    if (Array.isArray(block?.products)) {
      for (const p of block.products) {
        if (p?.id) items.push({ id: p.id, name: p.name || '' });
      }
    }
  }
  return { status: resp.status, items, url };
}

async function fetchPriceMatrix({ arrival, nights, units, adults, childrenAges, productIds, headers, ranges }) {
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges: serializeAges(childrenAges),
    mealCode: '',
    currency: 'EUR',
    nightsRange: ranges?.nightsRange ?? 1,
    arrivalRange: ranges?.arrivalRange ?? 1,
  };
  const url = `${BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });
  return { status: resp.status, url, payload, data: resp.data };
}

// ===================== HANDLER =====================
async function offersHandler(req, res) {
  const {
    arrival,
    departure,
    adults = 2,
    units = 1,
    children = [],
    productIds: overrideIds,
    ranges = { arrivalRange: 1, nightsRange: 1 },
    dwSessionId, // volitelně: reuse prohlížečovou session
  } = req.body || {};

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(nights) || nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const childrenAges = (Array.isArray(children) ? children : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

  const headers = makeHeaders(dwSessionId);
  const debug = {
    accommodationId: ACCOMMODATION_ID,
    baseUrl: BASE,
    sessionId: headers['DW-SessionId'],
    input: { arrival, departure, units, adults, childrenAges, nights },
    steps: [],
  };

  try {
    // 1) Search (Feratel to očekává u následných dotazů)
    const s = await createSearch({ arrival, departure, units, adults, childrenAges, headers });
    debug.steps.push({
      step: 'createSearch',
      status: s.status,
      searchId: s.id,
      searchPayload: s.payload,
    });
    if (!s.id) return res.status(502).json({ error: 'Failed to initiate search', debug });

    // 2) Názvy produktů
    const nameById = new Map();

    const sv = await tryFetchNamesViaServices(headers, s.id);
    debug.steps.push({ step: 'names/services', status: sv.status, count: sv.items.length, url: sv.url });
    for (const it of sv.items) nameById.set(it.id, it.name || '');

    if (nameById.size === 0) {
      const av = await tryFetchNamesViaAccommodation(headers);
      debug.steps.push({ step: 'names/accommodation', status: av.status, count: av.items.length, url: av.url });
      for (const it of av.items) nameById.set(it.id, it.name || '');
    }

    // 3) productIds
    const productIds =
      Array.isArray(overrideIds) && overrideIds.length ? overrideIds.slice() : DEFAULT_PRODUCT_IDS.slice();
    debug.steps.push({ step: 'productIds', count: productIds.length });

    // 4) Price matrix – nejprve UI‑like (arrivalRange/nightsRange 1/1)
    let pm = await fetchPriceMatrix({
      arrival,
      nights,
      units,
      adults,
      childrenAges,
      productIds,
      headers,
      ranges,
    });
    debug.steps.push({
      step: 'pricematrix',
      status: pm.status,
      url: pm.url,
      payload: pm.payload,
      preview: Array.isArray(pm.data) ? pm.data.slice(0, 1) : pm.data,
    });

    // fallback: 0/0 (přísné)
    const usable =
      Array.isArray(pm.data) &&
      pm.data.length &&
      pm.data.some((r) => r?.data && (r.data[String(nights)] || r.data[nights]));

    if (!(pm.status >= 200 && pm.status < 300 && usable)) {
      pm = await fetchPriceMatrix({
        arrival,
        nights,
        units,
        adults,
        childrenAges,
        productIds,
        headers,
        ranges: { arrivalRange: 0, nightsRange: 0 },
      });
      debug.steps.push({
        step: 'pricematrix-0-0',
        status: pm.status,
        payload: pm.payload,
        preview: Array.isArray(pm.data) ? pm.data.slice(0, 1) : pm.data,
      });
    }

    if (!(pm.status >= 200 && pm.status < 300) || !Array.isArray(pm.data)) {
      return res.status(502).json({ error: 'Price matrix not available', debug });
    }

    // 5) Výběr přesného "price per stay" z pásma nights
    const totals = new Map(); // id -> { totalPrice, available }
    for (const row of pm.data) {
      const pid = row?.productId;
      if (!pid || isDummyUUID(pid)) continue;

      const { price, picked } = selectStayPriceFromRow(row, arrival, nights);
      if (price <= 0) {
        totals.set(pid, { totalPrice: 0, available: false, picked });
        continue;
      }

      const extras = additionalServicesTotal(picked);
      totals.set(pid, { totalPrice: price + extras, available: true, picked });
    }

    const offers = productIds.map((pid) => {
      const rec = totals.get(pid) || { totalPrice: 0, available: false };
      return {
        productId: pid,
        name: nameById.get(pid) || '',
        totalPrice: Number(rec.totalPrice || 0),
        currency: 'EUR',
        availability: !!rec.available,
        nights,
      };
    });

    return res.json({ offers, debug });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('Feratel API ERROR:', details);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details, debug });
  }
}

// ===================== ROUTES =====================
app.post(['/offers', '/get-price'], offersHandler);

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    routes: ['POST /offers', 'POST /get-price'],
    accommodationId: ACCOMMODATION_ID,
    destination: DESTINATION,
  });
});

// ===================== START =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`🏨 Destination: ${DESTINATION} / ${PREFIX}`);
  console.log(`📍 Accommodation: ${ACCOMMODATION_ID}`);
});

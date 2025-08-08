// server.js
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

// ------------ KONFIG ------------
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';
const FERATEL_BASE    = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}`;

const FALLBACK_SERVICE_IDS = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

// Feratel chce přesnou hodnotu, tohle je ta, co používá Deskline front-end.
function feratelHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Origin':  'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
}

// Axios instance s timeoutem a bez zbytečných rejectů na 4xx
const http = axios.create({
  timeout: 15000,
  validateStatus: () => true
});

// ------------ HELPERS ------------
const toDate = (d) => new Date(`${d}T00:00:00Z`);

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.floor(x)));
}

// Z pole čísel udělá CSV, pro /pricematrix
function agesToCsv(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr.join(',');
}

// sečtení ceny pro položku dne
function numberOrZero(v){ return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function sumEntryPrice(e) {
  return numberOrZero(e?.price) ||
         numberOrZero(e?.value) ||
         numberOrZero(e?.amount) ||
         numberOrZero(e?.dayPrice) ||
         numberOrZero(e?.total);
}
function sumAdditional(entry) {
  let extra = 0;
  if (Array.isArray(entry?.additionalServices)) {
    for (const s of entry.additionalServices) extra += numberOrZero(s?.price);
  }
  return extra;
}

// vybere „první pole“ z často měněné struktury odpovědi
function firstArrayInObject(obj){
  if (!obj || typeof obj !== 'object') return [];
  for (const k of Object.keys(obj)) if (Array.isArray(obj[k])) return obj[k];
  return [];
}
function pluckArrayCandidates(data){
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const candidates = [
    data.items, data.results, data.services, data.data, firstArrayInObject(data)
  ].filter(Array.isArray);
  return candidates[0] || [];
}

// Normalizace vstupu – podporuje:
// 1) jednoduchý tvar: {units, adults, children, childrenAges}
// 2) více obsazeností: {lines:[{units, adults, childrenAges:[...]}, ...]}
function normalizeInput(body) {
  const out = {
    arrival: body?.arrival,
    departure: body?.departure,
    lines: []
  };

  // varianta 2 – pole obsazeností
  if (Array.isArray(body?.lines) && body.lines.length) {
    for (const raw of body.lines) {
      const units = clampInt(raw?.units ?? 1, 1, 20);
      const adults = clampInt(raw?.adults ?? 2, 0, 10);
      // pro jistotu vždy pole věků (čísla >=0)
      let ages = Array.isArray(raw?.childrenAges) ? raw.childrenAges : [];
      ages = ages.map(a => clampInt(a, 0, 17)).filter(a => a >= 0);
      out.lines.push({ units, adults, childrenAges: ages });
    }
  } else {
    // varianta 1 – jednoduché paramy
    const units = clampInt(body?.units ?? 1, 1, 20);
    const adults = clampInt(body?.adults ?? 2, 0, 10);
    const childrenCount = clampInt(body?.children ?? 0, 0, 10);
    let ages = Array.isArray(body?.childrenAges) ? body.childrenAges : [];

    // pokud přišel jen počet dětí, doplníme defaultní věk 8
    if ((!ages || !ages.length) && childrenCount > 0) {
      ages = Array.from({ length: childrenCount }, () => 8);
    }
    ages = ages.map(a => clampInt(a, 0, 17)).filter(a => a >= 0);

    out.lines.push({ units, adults, childrenAges: ages });
  }

  // sloučíme všechny linie do jedné sumy pro /pricematrix,
  // protože pricematrix API bere adults/units jako sumu, a childrenAges jako CSV
  const totals = out.lines.reduce((acc, l) => {
    acc.units  += l.units;
    acc.adults += l.adults * l.units; // adults jsou „na jednotku“
    for (let i = 0; i < l.units; i++) acc.childrenAges.push(...l.childrenAges);
    return acc;
  }, { units: 0, adults: 0, childrenAges: [] });

  return { ...out, totals };
}

// ------------ FERATEL VOLÁNÍ ------------
async function createSearch({ arrival, departure, lines }) {
  const headers = feratelHeaders();

  // Feratel /searches chce jednotlivé řádky jako searchLines (units/adults/children/childrenAges)
  const searchLines = lines.map(l => ({
    units: l.units,
    adults: l.adults,
    children: l.childrenAges.length,
    childrenAges: l.childrenAges
  }));

  const payload = {
    searchObject: {
      searchGeneral: {
        dateFrom: `${arrival}T00:00:00.000`,
        dateTo:   `${departure}T00:00:00.000`
      },
      searchAccommodation: { searchLines }
    }
  };

  const resp = await http.post('https://webapi.deskline.net/searches', payload, { headers });
  if (resp.status >= 200 && resp.status < 300) {
    return { id: resp.data?.id || null, raw: resp.data };
  }
  const err = new Error('Search failed');
  err.response = resp.data;
  throw err;
}

async function fetchServices(searchId) {
  const headers = feratelHeaders();
  const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
  const tried = [];

  const urls = [
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`,
    `${FERATEL_BASE}/services/searchresults/${encodeURIComponent(searchId)}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`,
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`
  ];

  for (const url of urls) {
    const resp = await http.get(url, { headers });
    tried.push({ url, status: resp.status });
    if (resp.status >= 200 && resp.status < 300) {
      const items = pluckArrayCandidates(resp.data);
      if (Array.isArray(items) && items.length) {
        return { items, tried, used: url };
      }
    }
  }

  // fallback: packages -> products
  const pkgFields = 'id,name,products{id,name}';
  const pkgUrl = `${FERATEL_BASE}/packages?fields=${encodeURIComponent(pkgFields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`;
  const pResp = await http.get(pkgUrl, { headers });
  tried.push({ url: pkgUrl, status: pResp.status });

  if (pResp.status >= 200 && pResp.status < 300) {
    const arr = pluckArrayCandidates(pResp.data);
    const items = [];
    for (const p of arr) {
      if (Array.isArray(p?.products)) {
        for (const pr of p.products) items.push({ id: pr.id, name: pr.name });
      }
    }
    if (items.length) return { items, tried, used: pkgUrl };
  }

  return { items: [], tried, used: null };
}

async function fetchPriceMatrix({ arrival, nights, totals, productIds }) {
  const headers = feratelHeaders();
  // /pricematrix chce childrenAges jako CSV string, nikoliv pole
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units: totals.units,
    adults: totals.adults,
    childrenAges: agesToCsv(totals.childrenAges),
    mealCode: null,
    currency: 'EUR',
    nightsRange: 0,
    arrivalRange: 0
  };

  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await http.post(url, payload, { headers });
  if (resp.status >= 200 && resp.status < 300) {
    return { data: resp.data, payload, url };
  }
  const err = new Error('Price matrix failed');
  err.response = resp.data;
  throw err;
}

// ------------ ENDPOINT ------------
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/', (_, res) => res.json({ ok: true, service: 'feratel-price-api' }));

app.post('/get-price', async (req, res) => {
  try {
    const norm = normalizeInput(req.body || {});
    const { arrival, departure, lines, totals } = norm;

    if (!arrival || !departure) {
      return res.status(400).json({ error: 'Missing arrival or departure date' });
    }

    const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
    if (nights <= 0) {
      return res.status(400).json({ error: 'Departure date must be after arrival date' });
    }

    const debug = {
      dwSource: 'dwapp-accommodation',
      input: { arrival, departure, lines, totals, nights }
    };

    // 1) vytvořit search
    const search = await createSearch({ arrival, departure, lines });
    debug.searchId = search.id;

    // 2) načíst services
    const svc = await fetchServices(search.id);
    debug.servicesTried = svc.tried;
    debug.servicesUsed  = svc.used;
    debug.servicesCount = svc.items.length;

    let productIds = svc.items.map(i => i?.id).filter(Boolean);
    const nameById = new Map(svc.items.map(i => [i?.id, i?.name || '']));

    if (!productIds.length) {
      // poslední fallback
      productIds = FALLBACK_SERVICE_IDS.slice();
      debug.usedFallbackIds = true;
    }

    // 3) ceníky
    const pm = await fetchPriceMatrix({ arrival, nights, totals, productIds });
    debug.priceUrl = pm.url;
    debug.sentToPriceMatrix = {
      ...pm.payload,
      productIdsCount: pm.payload.productIds.length
    };

    const rows = Array.isArray(pm.data) ? pm.data : [];
    debug.gotMatrixRows = rows.length;

    // 4) výpočet
    const priceLookup = {};
    for (const row of rows) {
      const pid = row?.productId;
      if (!pid) continue;

      let total = 0;
      let nightsCounted = 0;

      const daysObj = row?.data && typeof row.data === 'object' ? row.data : {};
      for (const k of Object.keys(daysObj)) {
        const dayList = Array.isArray(daysObj[k]) ? daysObj[k] : [];
        for (const e of dayList) {
          const base  = sumEntryPrice(e);
          const extra = sumAdditional(e);
          if (base > 0 || extra > 0) {
            total += base + extra;
            nightsCounted += (base > 0 ? 1 : 0);
          }
        }
      }

      priceLookup[pid] = { total, nightsCounted };
    }

    // 5) odpověď
    const offers = productIds.map(pid => {
      const price = priceLookup[pid] || { total: 0, nightsCounted: 0 };
      return {
        productId: pid,
        name: nameById.get(pid) || '',
        totalPrice: price.total,
        currency: 'EUR',
        availability: price.total > 0 && price.nightsCounted >= nights,
        nights
      };
    });

    return res.json({ offers, debug });
  } catch (err) {
    // Pro Render logy – ať vidíš co přesně Feratel vrátil.
    console.error('Feratel API ERROR:', err?.response || err?.message || err);
    return res.status(500).json({
      error: 'Failed to fetch data from Feratel',
      details: err?.response || err?.message || 'Unknown error'
    });
  }
});

// ------------ START ------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

// server.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ====== CONFIG ======
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

// ✔ Ověřená sada productIds z DevTools (fungující v UI)
const VERIFIED_PRODUCT_IDS = [
  'b4265783-9c09-44e0-9af1-63ad964d64b9',
  'bda33d85-729b-40ca-ba2b-de4ca5e5841b',
  '78f0ede7-ce03-4806-8556-0d627bff27de',
  'bdd9a73d-7429-4610-9347-168b4b2785d8',
  '980db5a5-ac66-49f3-811f-0da67cc4a972',
  '0d0ae603-3fd9-4abd-98e8-eea813fd2d89'
];

// Starší „historická“ IDs (když vše ostatní selže)
const LEGACY_FALLBACK_IDS = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

const FERATEL_BASE = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}`;

function makeHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    // přesně jako web
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Origin':  'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
}

const toDate = s => new Date(s + 'T00:00:00Z');
const numberOrZero = v => (typeof v === 'number' && isFinite(v) ? v : 0);

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
function serializeChildrenAges(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const clean = arr.map(x => Number(x)).filter(n => Number.isFinite(n) && n >= 0);
  return clean.length ? clean.join(',') : '';
}

// ---- API helpers ------------------------------------------------------------

async function createSearch({ arrival, departure, lines }) {
  const headers = makeHeaders();
  const searchLines = lines.map(l => ({
    units: l.units,
    adults: l.adults,
    children: (Array.isArray(l.childrenAges) ? l.childrenAges.length : 0),
    childrenAges: serializeChildrenAges(l.childrenAges)
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

  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers });
  return { searchId: resp.data?.id || null, payload, headersUsed: headers['DW-Source'] };
}

// Pokus o získání produktů z detailu ubytování (někdy 400 bez kompletních fragmentů)
async function fetchProductsViaAccommodation(searchId) {
  const headers = makeHeaders();
  const tried = [];

  // Zkusíme několik variant fields (někdy API vyžaduje i top-level id)
  const fieldsVariants = [
    'id,products{id,name}',
    'products{id,name}'
  ];

  for (const fields of fieldsVariants) {
    const urlWithSearch = `${FERATEL_BASE}?fields=${encodeURIComponent(fields)}&currency=EUR&searchId=${encodeURIComponent(searchId)}`;
    const urlPlain      = `${FERATEL_BASE}?fields=${encodeURIComponent(fields)}&currency=EUR`;

    for (const url of [urlWithSearch, urlPlain]) {
      try {
        const resp = await axios.get(url, { headers, validateStatus: () => true });
        tried.push({ url, status: resp.status });

        if (resp.status >= 200 && resp.status < 300) {
          const data = resp.data;
          let products = [];

          if (Array.isArray(data)) {
            for (const acc of data) {
              if (Array.isArray(acc?.products)) products.push(...acc.products);
            }
          } else if (data && typeof data === 'object') {
            if (Array.isArray(data.products)) products = data.products;
            if (!products.length && Array.isArray(data?.items)) {
              for (const it of data.items) {
                if (Array.isArray(it?.products)) products.push(...it.products);
              }
            }
          }

          if (products.length) {
            const items = products.filter(p => p?.id).map(p => ({ id: p.id, name: p.name || '' }));
            if (items.length) return { items, urlUsed: url, tried };
          }
        }
      } catch (e) {
        tried.push({ url, error: e.message });
      }
    }
  }

  return { items: [], urlUsed: null, tried };
}

// (Nouzově) services – často 204
async function fetchProductsViaServices(searchId) {
  const headers = makeHeaders();
  const tried = [];
  const fields = 'id,name';

  const urls = [
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&searchId=${encodeURIComponent(searchId)}`,
    `${FERATEL_BASE}/services/searchresults/${encodeURIComponent(searchId)}?fields=${encodeURIComponent(fields)}&currency=EUR`,
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR`
  ];

  for (const url of urls) {
    try {
      const resp = await axios.get(url, { headers, validateStatus: () => true });
      tried.push({ url, status: resp.status });
      if (resp.status >= 200 && resp.status < 300) {
        let arr = [];
        if (Array.isArray(resp.data)) arr = resp.data;
        else if (resp.data && typeof resp.data === 'object') {
          for (const k of Object.keys(resp.data)) {
            if (Array.isArray(resp.data[k])) { arr = resp.data[k]; break; }
          }
        }
        if (arr.length) {
          const items = arr.filter(x => x?.id).map(x => ({ id: x.id, name: x.name || '' }));
          if (items.length) return { items, urlUsed: url, tried };
        }
      }
    } catch (e) {
      tried.push({ url, error: e.message });
    }
  }

  return { items: [], urlUsed: null, tried };
}

async function fetchPriceMatrix({ arrival, nights, totalUnits, totalAdults, allChildrenAges, productIds }) {
  const headers = makeHeaders();
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units: totalUnits,
    adults: totalAdults,
    childrenAges: serializeChildrenAges(allChildrenAges),
    mealCode: "",
    currency: 'EUR',
    nightsRange: 1,
    arrivalRange: 1
  };

  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });
  return { data: resp.data, status: resp.status, url, payload };
}

// Detekce „neplatných“ productIds podle nulového GUID v matrixu
function matrixLooksInvalid(rows) {
  if (!Array.isArray(rows) || !rows.length) return true;
  const r0 = rows[0];
  return !r0?.productId || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(r0.productId);
}

// ====== HTTP endpoint ======
app.post('/get-price', async (req, res) => {
  const {
    arrival, departure,
    adults = 2, units = 1,
    children = [],
    lines = null,
    productIds: overrideProductIds = null
  } = req.body || {};

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24*60*60*1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  const effectiveLines = Array.isArray(lines) && lines.length
    ? lines.map(L => ({
        units:  Number(L.units)   || 0,
        adults: Number(L.adults)  || 0,
        childrenAges: Array.isArray(L.childrenAges) ? L.childrenAges : []
      }))
    : [{ units, adults, childrenAges }];

  const totalUnits  = effectiveLines.reduce((s, l) => s + (Number(l.units)  || 0), 0) || units;
  const totalAdults = effectiveLines.reduce((s, l) => s + (Number(l.adults) || 0), 0) || adults;
  const allChildrenAges = effectiveLines.flatMap(l => Array.isArray(l.childrenAges) ? l.childrenAges : []);

  const debug = {
    input: { arrival, departure, units, adults, childrenAges, nights },
    steps: []
  };

  try {
    // 1) search
    const { searchId, payload: searchPayload, headersUsed } =
      await createSearch({ arrival, departure, lines: effectiveLines });
    debug.searchId = searchId;
    debug.steps.push({ step: 'createSearch', headersUsed, searchPayload });

    if (!searchId) return res.status(502).json({ error: 'Failed to initiate search' });

    // 2) produktová ID — priority: request override → ENV → accommodation → services → VERIFIED → LEGACY
    let items = [];
    let productSources = [];

    // a) override z požadavku (pro přesné A/B srovnání s UI)
    if (Array.isArray(overrideProductIds) && overrideProductIds.length) {
      items = overrideProductIds.map(id => ({ id, name: '' }));
      productSources.push({ label: 'override', count: items.length });
    }

    // b) ENV JSON (PRODUCT_IDS='["id1","id2"]')
    if (!items.length && process.env.PRODUCT_IDS) {
      try {
        const envIds = JSON.parse(process.env.PRODUCT_IDS);
        if (Array.isArray(envIds) && envIds.length) {
          items = envIds.map(id => ({ id, name: '' }));
          productSources.push({ label: 'env', count: items.length });
        }
      } catch (_) { /* ignore */ }
    }

    // c) accommodation products
    if (!items.length) {
      const viaAcc = await fetchProductsViaAccommodation(searchId);
      productSources.push({ label: 'accommodation', usedUrl: viaAcc.urlUsed, tried: viaAcc.tried, count: viaAcc.items.length });
      if (viaAcc.items.length) items = viaAcc.items;
    }

    // d) services (často 204)
    if (!items.length) {
      const viaSrv = await fetchProductsViaServices(searchId);
      productSources.push({ label: 'services', usedUrl: viaSrv.urlUsed, tried: viaSrv.tried, count: viaSrv.items.length });
      if (viaSrv.items.length) items = viaSrv.items;
    }

    // e) ověřená sada z DevTools
    if (!items.length) {
      items = VERIFIED_PRODUCT_IDS.map(id => ({ id, name: '' }));
      productSources.push({ label: 'verified-fallback', count: items.length });
    }

    // f) historická nouzová
    if (!items.length) {
      items = LEGACY_FALLBACK_IDS.map(id => ({ id, name: '' }));
      productSources.push({ label: 'legacy-fallback', count: items.length });
    }

    debug.productSources = productSources;
    const productIds = items.map(i => i.id).filter(Boolean);
    const nameById   = new Map(items.map(i => [i.id, i.name || '']));

    if (!productIds.length) {
      return res.status(404).json({ error: 'No products found for given search' });
    }

    // 3) price matrix – přesně jako UI
    let pm = await fetchPriceMatrix({
      arrival, nights,
      totalUnits, totalAdults,
      allChildrenAges,
      productIds
    });

    debug.priceUrl    = pm.url;
    debug.priceStatus = pm.status;
    debug.pricePayload= pm.payload;

    // pokud to vypadá na neplatná IDs (nulový GUID), zkus ověřenou sadu
    if (matrixLooksInvalid(pm.data) && productSources[0]?.label !== 'verified-fallback') {
      const verified = VERIFIED_PRODUCT_IDS.map(id => ({ id, name: '' }));
      const vidz = verified.map(v => v.id);
      pm = await fetchPriceMatrix({
        arrival, nights, totalUnits, totalAdults, allChildrenAges, productIds: vidz
      });
      debug.retriedWithVerified = { status: pm.status, productIdsCount: vidz.length };
      for (const v of verified) if (!nameById.has(v.id)) nameById.set(v.id, v.name || '');
    }

    // 4) sumace
    const rows = Array.isArray(pm.data) ? pm.data : [];
    debug.matrixPreview = Array.isArray(rows) ? rows.slice(0, 2).map(r => ({
      productId: r?.productId,
      hasDataKeys: r && r.data ? Object.keys(r.data).length : 0
    })) : { type: typeof pm.data };

    const priceLookup = {};
    for (const row of rows) {
      const pid = row?.productId;
      if (!pid) continue;

      let total = 0;
      let nightsCounted = 0;
      const daysObj = row?.data && typeof row.data === 'object' ? row.data : {};
      for (const day of Object.keys(daysObj)) {
        const entries = Array.isArray(daysObj[day]) ? daysObj[day] : [];
        for (const e of entries) {
          const base = sumEntryPrice(e);
          const extra = sumAdditional(e);
          if (base > 0 || extra > 0) {
            total += base + extra;
            nightsCounted += (base > 0 ? 1 : 0);
          }
        }
      }
      priceLookup[pid] = { total, nightsCounted };
    }

    const offers = (Array.isArray(pm.payload?.productIds) ? pm.payload.productIds : productIds)
      .map(pid => {
        const name = nameById.get(pid) || '';
        const rec  = priceLookup[pid] || { total: 0, nightsCounted: 0 };
        const available = rec.total > 0 && rec.nightsCounted >= nights;
        return {
          productId: pid,
          name,
          totalPrice: rec.total,
          currency: 'EUR',
          availability: available,
          nights
        };
      });

    return res.json({ offers, debug });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('Feratel API ERROR:', details);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

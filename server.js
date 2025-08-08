// server.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// === Feratel config (ponech dle své instalace)
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

// Poslední záchrana, když nevyjdou žádné zdroje produktů
const FALLBACK_SERVICE_IDS = [
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
    // toto si Feratel kontroluje – pro Deskline web funguje tato hodnota:
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Origin':  'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
}

const numberOrZero = v => (typeof v === 'number' && isFinite(v) ? v : 0);
// pokryje různé názvy částek v matrixu
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
const toDate = s => new Date(s + 'T00:00:00Z');

function serializeChildrenAges(arr) {
  // přesně jako na webu: "" když žádné dítě, jinak "4,7"
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const clean = arr
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && n >= 0);
  return clean.length ? clean.join(',') : '';
}

// --- API helpers -------------------------------------------------------------

async function createSearch({ arrival, departure, lines }) {
  // lines = [{ units, adults, childrenAges: [..] }, ...]
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

  const headers = makeHeaders();
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers });
  return { searchId: resp.data?.id || null, request: payload, headersUsed: headers['DW-Source'] };
}

// Získání produktů přímo z detailu ubytování (jak to dělá UI)
async function fetchProductsViaAccommodation(searchId) {
  // z tvého HARu: products{id,isBookable,isOfferable,..., name, price{…}}
  const fields =
    'products{id,name,isBookable,isOfferable,isBookableOnRequest,searchLine,price{min,max,calcRule,calcDuration,dailyPrice}}';

  const headers = makeHeaders();
  const urls = [
    // 1) s searchId (primární)
    `${FERATEL_BASE}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`,
    // 2) bez searchId (fallback)
    `${FERATEL_BASE}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`
  ];

  const tried = [];
  for (const url of urls) {
    try {
      const resp = await axios.get(url, { headers, validateStatus: () => true });
      tried.push({ url, status: resp.status });
      const data = resp.data;

      // data může být objekt { products: [...] } nebo pole; ošetříme oboje
      let products = [];
      if (Array.isArray(data)) {
        for (const acc of data) {
          if (Array.isArray(acc?.products)) products.push(...acc.products);
        }
      } else if (data && typeof data === 'object') {
        if (Array.isArray(data.products)) products = data.products;
        // někdy bývá vnořeno
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k]?.products)) products.push(...data[k].products);
        }
      }

      if (products.length) {
        const items = products
          .filter(p => p?.id)
          .map(p => ({ id: p.id, name: p.name || '' }));
        if (items.length) return { items, urlUsed: url, tried };
      }
    } catch (e) {
      tried.push({ url, error: e.message });
    }
  }
  return { items: [], urlUsed: null, tried };
}

// (nouzově) načíst services (často vrací 204)
async function fetchProductsViaServices(searchId) {
  const headers = makeHeaders();
  const fields =
    'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
  const urls = [
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`,
    `${FERATEL_BASE}/services/searchresults/${encodeURIComponent(searchId)}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`,
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`
  ];

  const tried = [];
  for (const url of urls) {
    try {
      const resp = await axios.get(url, { headers, validateStatus: () => true });
      tried.push({ url, status: resp.status });

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
    } catch (e) {
      tried.push({ url, error: e.message });
    }
  }
  return { items: [], urlUsed: null, tried };
}

async function fetchPriceMatrix({ arrival, nights, units, adults, childrenAges, productIds }) {
  const headers = makeHeaders();

  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    // přesně jako UI: "" pokud bez dětí, jinak "4,7"
    childrenAges: serializeChildrenAges(childrenAges),
    mealCode: "",            // UI posílá prázdný string
    currency: 'EUR',
    nightsRange: 1,          // UI posílá 1
    arrivalRange: 1          // UI posílá 1
  };

  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });

  return { data: resp.data, status: resp.status, url, payload };
}

// --- HTTP endpoint -----------------------------------------------------------

app.post('/get-price', async (req, res) => {
  // umíme i multi-occupancy jako UI ("lines"), jinak single fallback:
  const {
    arrival,
    departure,
    adults = 2,
    units = 1,
    children = [],
    lines = null,
    productIds: productIdsOverride = null // ruční override pro rychlý test
  } = req.body || {};

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24*60*60*1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  // Normalizace children na čísla
  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  // Pokud nepřijde `lines`, poskládáme je z legacy parametrů
  const effectiveLines = Array.isArray(lines) && lines.length
    ? lines.map(L => ({
        units:  Number(L.units)   || 1,
        adults: Number(L.adults)  || 0,
        childrenAges: Array.isArray(L.childrenAges) ? L.childrenAges : []
      }))
    : [{ units, adults, childrenAges }];

  const debug = {
    input: { arrival, departure, units, adults, childrenAges, nights },
    steps: []
  };

  try {
    // 1) search
    const { searchId, request: searchPayload, headersUsed } =
      await createSearch({ arrival, departure, lines: effectiveLines });
    debug.searchId = searchId;
    debug.steps.push({ step: 'createSearch', headersUsed, searchPayload });

    if (!searchId) {
      return res.status(502).json({ error: 'Failed to initiate search' });
    }

    // 2) produkty
    let items = [];
    let sourcesTried = [];

    if (Array.isArray(productIdsOverride) && productIdsOverride.length) {
      // ruční override z klienta
      items = productIdsOverride.map(id => ({ id, name: '' }));
      debug.steps.push({ step: 'productIdsOverride', count: items.length });
    } else {
      // a) preferovaný zdroj: detail ubytování (products{...})
      const viaAcc = await fetchProductsViaAccommodation(searchId);
      sourcesTried.push({ label: 'accommodation', ...viaAcc });
      if (viaAcc.items.length) items = viaAcc.items;

      // b) jako záloha: services
      if (!items.length) {
        const viaSrv = await fetchProductsViaServices(searchId);
        sourcesTried.push({ label: 'services', ...viaSrv });
        if (viaSrv.items.length) items = viaSrv.items;
      }

      // c) nouzový fallback
      if (!items.length) {
        items = FALLBACK_SERVICE_IDS.map(id => ({ id, name: '' }));
        debug.usedFallback = true;
      }
    }

    debug.productSources = sourcesTried.map(s => ({
      label: s.label, usedUrl: s.urlUsed, tried: s.tried, count: s.items?.length || 0
    }));

    const productIds = items.map(i => i.id).filter(Boolean);
    if (!productIds.length) {
      return res.status(404).json({ error: 'No products found for given search' });
    }

    const nameById = new Map(items.map(i => [i.id, i.name || '']));

    // 3) price matrix přesně jako UI
    const pm = await fetchPriceMatrix({
      arrival, nights,
      units: effectiveLines.reduce((s, l) => s + (Number(l.units)||0), 0) || units,
      adults: effectiveLines.reduce((s, l) => s + (Number(l.adults)||0), 0) || adults,
      childrenAges: effectiveLines.flatMap(l => (Array.isArray(l.childrenAges) ? l.childrenAges : [])),
      productIds
    });

    debug.priceUrl = pm.url;
    debug.priceStatus = pm.status;
    debug.pricePayload = pm.payload;

    // Při problému chceme vidět kousek odpovědi
    if (Array.isArray(pm.data)) {
      debug.matrixPreview = pm.data.slice(0, 2).map(r => ({
        productId: r?.productId,
        hasDataKeys: r && r.data ? Object.keys(r.data).length : 0
      }));
    } else {
      debug.matrixPreview = { type: typeof pm.data, keys: pm.data && Object.keys(pm.data) };
    }

    // 4) sumace
    const priceLookup = {};
    const rows = Array.isArray(pm.data) ? pm.data : [];
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

    // 5) výstup
    const offers = productIds.map(pid => {
      const name = nameById.get(pid) || '';
      const rec = priceLookup[pid] || { total: 0, nightsCounted: 0 };
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

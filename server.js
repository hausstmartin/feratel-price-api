const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---- Feratel context (ponech podle své instalace)
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

// Fallback pouze pokud nezískáme nic ze "services"
const FALLBACK_SERVICE_IDS = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

const FERATEL_BASE = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}`;
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  // Toto Feratel validuje; pro Deskline web je to právě tohle:
  'DW-Source': 'dwapp-accommodation',
  'DW-SessionId': Date.now().toString(),
  'Origin':  'https://direct.bookingandmore.com',
  'Referer': 'https://direct.bookingandmore.com'
};

function toDate(dateStr){ return new Date(dateStr + 'T00:00:00Z'); }

// Try to normalize a variety of Feratel list shapes to a flat array
function firstArrayInObject(obj){
  if (!obj || typeof obj !== 'object') return [];
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}
function pluckArrayCandidates(data){
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  // common nestings we’ve seen
  const candidates = [
    data.items,
    data.results,
    data.services,
    data.data,
    firstArrayInObject(data)
  ].filter(Array.isArray);

  return candidates[0] || [];
}

// Aggregate many possible numeric fields to capture totals
function numberOrZero(v){ return typeof v === 'number' && isFinite(v) ? v : 0; }
function sumEntryPrice(e){
  // Try multiple field names Feratel may use
  return numberOrZero(e?.price) ||
         numberOrZero(e?.value) ||
         numberOrZero(e?.amount) ||
         numberOrZero(e?.dayPrice) ||
         numberOrZero(e?.total);
}
function sumAdditional(entry){
  let extra = 0;
  if (Array.isArray(entry?.additionalServices)) {
    for (const s of entry.additionalServices) extra += numberOrZero(s?.price);
  }
  return extra;
}

async function createSearch({arrival, departure, units, adults, childrenAges}){
  const payload = {
    searchObject: {
      searchGeneral: { dateFrom: `${arrival}T00:00:00.000`, dateTo: `${departure}T00:00:00.000` },
      searchAccommodation: {
        searchLines: [
          { units, adults, children: childrenAges.length, childrenAges }
        ]
      }
    }
  };
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers: HEADERS_BASE });
  return resp.data?.id || null;
}

// Try several endpoints to fetch services bound to searchId
async function fetchServices(searchId){
  const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
  const urls = [
    // 1) canonical (w/ searchId)
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`,
    // 2) older pattern
    `${FERATEL_BASE}/services/searchresults/${encodeURIComponent(searchId)}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`,
    // 3) without searchId (last-resort)
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`,
  ];

  const debugTried = [];
  for (const url of urls){
    try{
      debugTried.push(url);
      const resp = await axios.get(url, { headers: HEADERS_BASE });
      const items = pluckArrayCandidates(resp.data);
      if (Array.isArray(items) && items.length) {
        return { items, urlUsed: url, tried: debugTried };
      }
    }catch(_e){ /* keep trying */ }
  }

  // 4) packages as an alternate source of productIds (via products[])
  try{
    const pkgFields = 'id,name,products{id,name}';
    const pkgUrl = `${FERATEL_BASE}/packages?fields=${encodeURIComponent(pkgFields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`;
    debugTried.push(pkgUrl);
    const resp = await axios.get(pkgUrl, { headers: HEADERS_BASE });
    const arr = pluckArrayCandidates(resp.data);
    const items = [];
    for (const p of arr) {
      if (Array.isArray(p?.products)) {
        for (const pr of p.products) items.push({ id: pr.id, name: pr.name });
      }
    }
    if (items.length) return { items, urlUsed: pkgUrl, tried: debugTried };
  }catch(_e){ /* ignore */ }

  return { items: [], urlUsed: null, tried: debugTried };
}

async function fetchPriceMatrix({arrival, nights, units, adults, childrenAges, productIds}){
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges,          // JSON array
    mealCode: null,
    currency: 'EUR',
    nightsRange: 0,
    arrivalRange: 0
  };
  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers: HEADERS_BASE });
  return { data: resp.data, urlUsed: url, payload };
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body || {};
  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24*60*60*1000));
  if (nights <= 0) return res.status(400).json({ error: 'Departure date must be after arrival date' });

  // normalize children ages
  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  const debug = { dwSource: HEADERS_BASE['DW-Source'] };

  try {
    // 1) search
    const searchId = await createSearch({ arrival, departure, units, adults, childrenAges });
    if (!searchId) {
      return res.status(502).json({ error: 'Failed to initiate search' });
    }
    debug.searchId = searchId;

    // 2) services (robust)
    const { items, urlUsed: servicesUrlUsed, tried: servicesTried } = await fetchServices(searchId);
    debug.servicesUrlUsed = servicesUrlUsed;
    debug.servicesTried = servicesTried;
    debug.gotServices = Array.isArray(items) ? items.length : 0;

    let productIds = (items || []).map(x => x?.id).filter(Boolean);
    const nameById = new Map((items || []).map(x => [x?.id, x?.name || '']));

    if (!productIds.length) {
      // last resort – fallback set (may return 0 pricing if not applicable)
      productIds = FALLBACK_SERVICE_IDS.slice();
      debug.usedFallbackIds = true;
    }

    // 3) price matrix
    const { data: pmData, urlUsed: priceUrlUsed, payload: sentPayload } =
      await fetchPriceMatrix({ arrival, nights, units, adults, childrenAges, productIds });
    debug.priceUrlUsed = priceUrlUsed;
    debug.sentToPriceMatrix = { ...sentPayload, // redact large arrays for debug clarity
      productIdsCount: sentPayload.productIds.length
    };

    // 4) build totals
    const priceLookup = {};   // productId -> { total, nightsCounted }
    let matrixRows = Array.isArray(pmData) ? pmData : [];
    debug.gotMatrix = matrixRows.length;

    for (const row of matrixRows) {
      const pid = row?.productId;
      if (!pid) continue;

      let total = 0;
      let nightsCounted = 0;

      // row.data is object keyed by dates; each value is array of entries for that day
      const daysObj = row?.data && typeof row.data === 'object' ? row.data : {};
      for (const k of Object.keys(daysObj)) {
        const dayList = Array.isArray(daysObj[k]) ? daysObj[k] : [];
        for (const e of dayList) {
          const base = sumEntryPrice(e);
          const extra = sumAdditional(e);
          if (base > 0 || extra > 0) {
            total += (base + extra);
            // count nights only if it's a real priced night
            nightsCounted += (base > 0 ? 1 : 0);
          }
        }
      }

      priceLookup[pid] = { total, nightsCounted };
    }

    // 5) offers
    const offers = productIds.map(pid => {
      const metaName = nameById.get(pid) || '';
      const rec = priceLookup[pid] || { total: 0, nightsCounted: 0 };
      const available = rec.total > 0 && rec.nightsCounted >= nights;
      return {
        productId: pid,
        name: metaName,
        totalPrice: rec.total,
        currency: 'EUR',
        availability: available,
        nights
      };
    });

    return res.json({ offers, debug });
  } catch (err) {
    console.error('Feratel API ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      error: 'Failed to fetch data from Feratel',
      details: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

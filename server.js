const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ---- KONFIG ----
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

// Z HARu / widgetu – fallback serviceIds, kdyby se služby nepodařilo načíst
const fallbackServiceIds = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

// Kandidáti pro DW-Source – Feratel někdy akceptuje jen konkrétní variantu.
// Můžeš přidat vlastní přes ENV: DW_SOURCE=xxx
const DW_SOURCE_CANDIDATES = [
  process.env.DW_SOURCE,
  'dwapp-accommodation',
  'dwapp-accommodation-result',
  'dwapp-result',
  'dwapp'
].filter(Boolean);

const COMMON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,cs;q=0.7',
  'Origin': 'https://direct.bookingandmore.com',
  'Referer': 'https://direct.bookingandmore.com/'
};

const api = axios.create({
  baseURL: 'https://webapi.deskline.net',
  timeout: 15000
});

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }
function toDate(dateStr) { return new Date(dateStr + 'T00:00:00Z'); }

// Obecné volání, které zkouší různé DW-Source hodnoty, dokud jedna neprojde
async function feratelCall(method, url, data) {
  let lastErr;
  for (const dw of DW_SOURCE_CANDIDATES) {
    const headers = {
      ...COMMON_HEADERS,
      'DW-Source': dw,
      'DW-SessionId': uuid()
    };
    try {
      const resp = await api.request({ method, url, data, headers });
      return { resp, usedDW: dw };
    } catch (err) {
      const msg = err?.response?.data || err.message;
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      // Pokud je explicitně problém s DW-Source, zkusíme další kandidát
      if (text && /DW-Source/i.test(text)) {
        lastErr = err;
        continue;
      }
      // Jiné chyby – ukonči hned
      throw err;
    }
  }
  // Všechny kandidáty selhaly
  throw lastErr || new Error('All DW-Source candidates failed');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, accommodationId, destination, prefix, ts: new Date().toISOString() });
});

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body || {};

  try {
    // ---- Validace vstupu ----
    if (!arrival || !departure) {
      return res.status(400).json({ error: 'Missing arrival or departure date' });
    }
    const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
    if (nights <= 0) {
      return res.status(400).json({ error: 'Departure date must be after arrival date' });
    }

    // childrenAges jako čisté pole čísel
    const childAgesArray = (Array.isArray(children) ? children : [])
      .map(n => Number(n))
      .filter(n => Number.isFinite(n) && n >= 0);
    const childAgesString = childAgesArray.length ? childAgesArray.join(',') : '';

    // ---- 1) /searches (childrenAges = ARRAY) ----
    const searchPayload = {
      searchObject: {
        searchGeneral: {
          dateFrom: `${arrival}T00:00:00.000`,
          dateTo:   `${departure}T00:00:00.000`
        },
        searchAccommodation: {
          searchLines: [{
            units,
            adults,
            children: childAgesArray.length,
            childrenAges: childAgesArray
          }]
        }
      }
    };

    const { resp: searchResp, usedDW: usedDW1 } =
      await feratelCall('post', '/searches', searchPayload);

    const searchId = searchResp?.data?.id;
    if (!searchId) {
      return res.status(502).json({ error: 'Failed to initiate search', details: searchResp?.data || null });
    }

    // ---- 2) /services s searchId, abychom dostali správné produkty ----
    const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl =
      `/${destination}/en/accommodations/${prefix}/${accommodationId}` +
      `/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;

    const { resp: servicesResp, usedDW: usedDW2 } =
      await feratelCall('get', servicesUrl);

    // Rozbalení pole položek z odpovědi (může být víceroobalené)
    let items = [];
    if (Array.isArray(servicesResp.data)) {
      items = servicesResp.data;
    } else if (servicesResp.data && typeof servicesResp.data === 'object') {
      for (const k of Object.keys(servicesResp.data)) {
        if (Array.isArray(servicesResp.data[k])) {
          items = servicesResp.data[k];
          break;
        }
      }
    }

    let productIds = (items || []).map(i => i?.id).filter(Boolean);
    if (!productIds.length) productIds = fallbackServiceIds.slice();

    // ---- 3) /pricematrix (childrenAges = STRING!) ----
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      childrenAges: childAgesString,  // <-- STRING, viz error z logu
      mealCode: '',
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };

    const priceUrl =
      `/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;

    const { resp: priceResp, usedDW: usedDW3 } =
      await feratelCall('post', priceUrl, pricePayload);

    // ---- 4) Výpočet total price (base + additionalServices) ----
    const priceLookup = {};
    if (Array.isArray(priceResp.data)) {
      for (const row of priceResp.data) {
        const pid = row.productId;
        let total = 0;
        let nightsCounted = 0;

        Object.values(row.data || {}).forEach(dayList => {
          (dayList || []).forEach(entry => {
            if (typeof entry?.price === 'number') {
              total += entry.price;
              nightsCounted += 1;
            }
            if (Array.isArray(entry?.additionalServices)) {
              for (const s of entry.additionalServices) {
                if (typeof s?.price === 'number') total += s.price; // tax/cleaning apod.
              }
            }
          });
        });

        priceLookup[pid] = {
          total,
          available: nightsCounted >= nights && total > 0
        };
      }
    }

    const offers = productIds.map(pid => {
      const meta = (items || []).find(i => i?.id === pid) || {};
      const price = priceLookup[pid] || { total: 0, available: false };
      return {
        productId: pid,
        name: meta.name || '',
        totalPrice: price.total,
        currency: 'EUR',
        availability: price.available,
        nights
      };
    });

    // Můžeme přidat debug info, co pomohlo (který DW-Source prošel)
    return res.json({
      offers,
      debug: { usedDW1, usedDW2, usedDW3 }
    });

  } catch (err) {
    const details = err?.response?.data || err.message || 'Unknown error';
    console.error('Feratel API ERROR:', details);
    return res.status(502).json({
      error: 'Failed to fetch data from Feratel',
      details
    });
  }
});

const PORT = process.env.PORT || 10000; // Render si port sám propíše
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

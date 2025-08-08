const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination = 'accbludenz';
const prefix = 'BLU';

const FERATEL_BASE = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}`;
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'DW-Source': 'dwapp-accommodation',
  'DW-SessionId': Date.now().toString(),
  'Origin': 'https://direct.bookingandmore.com',
  'Referer': 'https://direct.bookingandmore.com'
};

function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function pluckArrayCandidates(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const candidates = [
    data.items,
    data.results,
    data.services,
    data.data
  ].filter(Array.isArray);
  return candidates[0] || [];
}

async function createSearch({ arrival, departure, units, adults, childrenAges }) {
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
          childrenAges // posíláme jako pole čísel
        }]
      }
    }
  };
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers: HEADERS_BASE });
  return resp.data?.id || null;
}

async function fetchServices(searchId) {
  const fields = 'id,name,fromPrice{value,mealCode}';
  const urls = [
    `${FERATEL_BASE}/services/searchresults/${encodeURIComponent(searchId)}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100`,
    `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&pageSize=100&searchId=${encodeURIComponent(searchId)}`
  ];
  const tried = [];
  for (const url of urls) {
    try {
      const resp = await axios.get(url, { headers: HEADERS_BASE });
      tried.push({ url, status: resp.status });
      const arr = pluckArrayCandidates(resp.data);
      if (arr.length) {
        return { items: arr, tried };
      }
    } catch (e) {
      tried.push({ url, status: e.response?.status || null, error: e.message });
    }
  }
  return { items: [], tried };
}

async function fetchPriceForProduct({ arrival, nights, units, adults, childrenAges, productId, mealCode }) {
  const payload = {
    productIds: [productId],
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges, // pole čísel
    mealCode: mealCode || '',
    currency: 'EUR',
    nightsRange: 1,
    arrivalRange: 1
  };
  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers: HEADERS_BASE });
  return { data: resp.data, payload, url };
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body || {};
  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  const debug = {
    input: { arrival, departure, units, adults, childrenAges, nights }
  };

  try {
    const searchId = await createSearch({ arrival, departure, units, adults, childrenAges });
    debug.searchId = searchId;
    if (!searchId) {
      return res.status(502).json({ error: 'Failed to create search' });
    }

    const { items: services, tried: servicesTried } = await fetchServices(searchId);
    debug.servicesTried = servicesTried;
    debug.servicesCount = services.length;

    if (!services.length) {
      return res.status(404).json({ error: 'No products found for given search' });
    }

    const offers = [];
    for (const srv of services) {
      const productId = srv.id;
      const mealCode = srv?.fromPrice?.mealCode || '';
      const priceRes = await fetchPriceForProduct({ arrival, nights, units, adults, childrenAges, productId, mealCode });
      debug[`priceRequest_${productId}`] = { payload: priceRes.payload, url: priceRes.url };

      let totalPrice = 0;
      let available = false;
      if (Array.isArray(priceRes.data)) {
        for (const row of priceRes.data) {
          const daysObj = row?.data || {};
          for (const dayKey of Object.keys(daysObj)) {
            const entries = daysObj[dayKey] || [];
            for (const entry of entries) {
              if (entry?.price) {
                totalPrice += entry.price;
                available = true;
              }
            }
          }
        }
      }
      offers.push({
        productId,
        totalPrice,
        currency: 'EUR',
        availability: available,
        nights
      });
    }

    return res.json({ offers, debug });
  } catch (err) {
    console.error('Feratel API ERROR:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details: err.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
});

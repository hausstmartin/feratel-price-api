const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

const fallbackServiceIds = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

// Možné DW-Source hodnoty – primární + fallback
const DW_SOURCES = ['haus-bludenz', 'dwapp-accommodation'];

function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

async function feratelCall(method, url, payload, dwSource) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'DW-Source': dwSource,
    'DW-SessionId': Date.now().toString(),
    'Origin':  'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
  const fullUrl = url.startsWith('http') ? url : `https://webapi.deskline.net${url}`;
  const resp = await axios({
    method,
    url: fullUrl,
    data: payload,
    headers
  });
  return resp;
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body;

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }
  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24*60*60*1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const parsedChildren = (Array.isArray(children) ? children : [])
    .map(age => Number(age))
    .filter(n => !isNaN(n) && n >= 0);

  let searchId, usedDW;
  let services = [];

  try {
    // 1) Najdi funkční DW-Source
    for (const dw of DW_SOURCES) {
      try {
        const searchPayload = {
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
                  children: parsedChildren.length,
                  childrenAges: parsedChildren.length > 0 ? parsedChildren : []
                }
              ]
            }
          }
        };
        const searchResp = await feratelCall('post', '/searches', searchPayload, dw);
        if (searchResp.data?.id) {
          searchId = searchResp.data.id;
          usedDW = dw;
          break;
        }
      } catch (err) {
        if (err.response?.data?.toString().includes('DW-Source')) {
          continue; // zkus další DW
        }
        throw err;
      }
    }
    if (!searchId) {
      return res.status(500).json({ error: 'No valid DW-Source found' });
    }

    // 2) /services
    const fields = 'id,name,translations,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl = `/${destination}/en/accommodations/${prefix}/${accommodationId}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;
    const servicesResp = await feratelCall('get', servicesUrl, null, usedDW);

    if (Array.isArray(servicesResp.data)) {
      services = servicesResp.data;
    } else {
      for (const k of Object.keys(servicesResp.data || {})) {
        if (Array.isArray(servicesResp.data[k])) {
          services = servicesResp.data[k];
          break;
        }
      }
    }

    let productIds = services.map(i => i.id).filter(Boolean);
    if (productIds.length === 0) productIds = fallbackServiceIds;

    // 3) /pricematrix – přidáme searchId
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      childrenAges: parsedChildren.length > 0 ? parsedChildren : [],
      mealCode: null,
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };
    const priceUrl = `/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix?searchId=${encodeURIComponent(searchId)}`;
    const priceResp = await feratelCall('post', priceUrl, pricePayload, usedDW);

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
              nightsCounted++;
            }
            if (Array.isArray(entry?.additionalServices)) {
              entry.additionalServices.forEach(s => {
                if (typeof s?.price === 'number') total += s.price;
              });
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
      const meta = services.find(i => i.id === pid) || {};
      const price = priceLookup[pid] || { total: 0, available: false };
      const name = meta.name || meta?.translations?.[0]?.text || '';
      return {
        productId: pid,
        name,
        totalPrice: price.total,
        currency: 'EUR',
        availability: price.available,
        nights
      };
    });

    return res.json({ offers, debug: { usedDW, searchId, productsFound: services.length } });
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

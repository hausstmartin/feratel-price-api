const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// === KONFIGURACE ===
const DW_SOURCES = [
  'dwapp-accommodation',
  'dwapp',
  'direct-booking',
  'haus-bludenz',
  'accbludenz'
];

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
  return axios({
    method,
    url: url.startsWith('http') ? url : `https://webapi.deskline.net${url}`,
    data: payload,
    headers
  });
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body;

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round(
    (toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000)
  );
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  // Čisté childrenAges
  const parsedChildren = (Array.isArray(children) ? children : [])
    .map(age => Number(age))
    .filter(n => !isNaN(n) && n >= 0);

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
            adults
          }
        ]
      }
    }
  };

  if (parsedChildren.length > 0) {
    searchPayload.searchObject.searchAccommodation.searchLines[0].children = parsedChildren.length;
    searchPayload.searchObject.searchAccommodation.searchLines[0].childrenAges = parsedChildren;
  }

  let searchId = null;
  let usedDW = null;

  try {
    // 1) Získání searchId s fallbackem DW-Source
    for (const dw of DW_SOURCES) {
      try {
        const resp = await feratelCall('post', '/searches', searchPayload, dw);
        if (resp.data?.id) {
          searchId = resp.data.id;
          usedDW = dw;
          break;
        }
      } catch (err) {
        const msg = JSON.stringify(err.response?.data || err.message);
        if (msg.includes('DW-Source')) {
          continue; // zkus další
        }
        throw err; // jiná chyba – ukonči
      }
    }

    if (!searchId) {
      return res.status(500).json({ error: 'Failed to initiate search with any DW-Source' });
    }

    // 2) Načíst služby (pokoje)
    const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl =
      `/${destination}/en/accommodations/${prefix}/${accommodationId}` +
      `/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;

    const servicesResp = await feratelCall('get', servicesUrl, null, usedDW);

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

    let productIds = items.map(i => i.id).filter(Boolean);
    if (productIds.length === 0) {
      productIds = fallbackServiceIds;
    }

    // 3) Zavolat pricematrix
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };

    if (parsedChildren.length > 0) {
      pricePayload.childrenAges = parsedChildren;
    }

    const priceUrl =
      `/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;

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
              nightsCounted += 1;
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

    // 4) Vrátit nabídky
    const offers = productIds.map(pid => {
      const meta = (items.find(i => i.id === pid) || {});
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

    return res.json({
      offers,
      debug: {
        usedDW
      }
    });

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

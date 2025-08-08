const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// === KONFIGURACE ===
// Správná hodnota DW-Source z HARu
const DW_SOURCE = 'dwapp-accommodation';

const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination     = 'accbludenz';
const prefix          = 'BLU';

// Fallback service IDs, pokud API nevrátí seznam
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

  // childrenAges musí být čisté pole čísel
  const parsedChildren = (Array.isArray(children) ? children : [])
    .map(age => Number(age))
    .filter(n => !isNaN(n) && n >= 0);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'DW-Source': DW_SOURCE,
    'DW-SessionId': Date.now().toString(),
    'Origin':  'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };

  try {
    // 1) vytvoření search
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
              childrenAges: parsedChildren
            }
          ]
        }
      }
    };

    const searchResp = await axios.post(
      'https://webapi.deskline.net/searches',
      searchPayload,
      { headers }
    );
    const searchId = searchResp.data?.id;
    if (!searchId) {
      return res.status(500).json({ error: 'Failed to initiate search', details: searchResp.data });
    }

    // 2) načtení služeb
    const fields =
      'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl =
      `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}` +
      `/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;

    const servicesResp = await axios.get(servicesUrl, { headers });

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

    // 3) získání cen
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      childrenAges: parsedChildren,
      mealCode: null,
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };

    const priceUrl =
      `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;

    const priceResp = await axios.post(priceUrl, pricePayload, { headers });

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

    // 4) návrat dat
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

    return res.json({ offers });
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

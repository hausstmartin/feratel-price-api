const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Feratel config
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination = 'accbludenz';
const prefix = 'BLU';

// (Nepovinné – můžou se hodit pro filtrování / mapování)
const serviceIds = [
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
  const {
    arrival,
    departure,
    adults = 2,
    children = [],
    units = 1
  } = req.body || {};

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const arrivalDate = toDate(arrival);
  const departureDate = toDate(departure);
  const nights = Math.round((departureDate - arrivalDate) / (24 * 60 * 60 * 1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };

  try {
    // 1) SEARCH – teď TENANT-SPECIFICKY
    const searchPayload = {
      searchObject: {
        searchGeneral: {
          dateFrom: `${arrival}T00:00:00.000`,
          dateTo: `${departure}T00:00:00.000`
        },
        searchAccommodation: {
          searchLines: [
            {
              units,
              adults,
              children: children.length,
              childrenAges: children
            }
          ]
        }
      }
    };

    const searchUrl = `https://webapi.deskline.net/${destination}/en/searches`;
    const searchResp = await axios.post(searchUrl, searchPayload, { headers });
    const searchId = searchResp.data?.id;

    if (!searchId) {
      console.warn('⚠️ searchResp without id', searchResp.data);
      return res.status(500).json({ error: 'Failed to initiate search', details: searchResp.data });
    }
    console.log('🔎 searchId:', searchId);

    // 2) SERVICES podle searchId (měly by být pokoje s cenou)
    const fields =
      'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl =
      `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services/searchresults/${searchId}` +
      `?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1`;

    const servicesResp = await axios.get(servicesUrl, { headers });

    let items = [];
    if (Array.isArray(servicesResp.data)) {
      items = servicesResp.data;
    } else if (servicesResp.data && typeof servicesResp.data === 'object') {
      // vyber první pole, které je polem
      const arrayProp = Object.values(servicesResp.data).find(v => Array.isArray(v));
      if (Array.isArray(arrayProp)) items = arrayProp;
    }

    console.log('🧩 services searchresults count:', items.length);

    // 2b) FALLBACK – když searchresults nic nevrátí, načti services napřímo
    if (!items || items.length === 0) {
      const svcFields =
        'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
      const svcUrl =
        `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services` +
        `?fields=${encodeURIComponent(svcFields)}&currency=EUR&pageNo=1`;
      const svcResp = await axios.get(svcUrl, { headers });

      if (Array.isArray(svcResp.data)) {
        items = svcResp.data;
      } else if (svcResp.data && typeof svcResp.data === 'object') {
        const arrayProp = Object.values(svcResp.data).find(v => Array.isArray(v));
        if (Array.isArray(arrayProp)) items = arrayProp;
      }
      console.log('🧯 fallback services count:', items.length);
    }

    if (!items || items.length === 0) {
      return res.json({ offers: [] });
    }

    // 3) PRICEMATRIX – spočítej součty za noci + additionalServices (taxy/úklid)
    const productIds = items.map(it => it.id);
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      childrenAges: children.join(',') || '',
      mealCode: '',
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };
    const priceUrl =
      `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;

    const priceResp = await axios.post(priceUrl, pricePayload, { headers });

    const priceLookup = {};
    if (Array.isArray(priceResp.data)) {
      for (const item of priceResp.data) {
        const pid = item.productId;
        let total = 0;
        let dayCount = 0;

        const dayBuckets = Object.values(item.data || {}); // např. day1, day2,...
        for (const dayList of dayBuckets) {
          for (const entry of dayList || []) {
            if (entry && typeof entry.price === 'number') {
              total += entry.price;
              dayCount++;
            }
            if (entry?.additionalServices) {
              for (const s of entry.additionalServices) {
                if (typeof s.price === 'number') total += s.price;
              }
            }
          }
        }

        priceLookup[pid] = {
          total,
          available: dayCount >= nights && total > 0
        };
      }
    } else {
      console.warn('⚠️ Unexpected pricematrix payload shape');
    }

    const offers = items.map(item => ({
      productId: item.id,
      name: item.name || '',
      totalPrice: priceLookup[item.id]?.total || 0,
      currency: 'EUR',
      availability: !!priceLookup[item.id]?.available,
      nights
    }));

    res.json({ offers });
  } catch (error) {
    console.error('Feratel API ERROR:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch data from Feratel',
      details: error.response?.data || error.message
    });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

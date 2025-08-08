const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const accommodationId = '5edbae02-da8e-4489-8349-4bb836450b3e';
const destination = 'accbludenz';
const prefix = 'BLU';

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
  const { arrival, departure, adults = 2, children = [] } = req.body;

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
    const searchPayload = {
      searchObject: {
        searchGeneral: {
          dateFrom: `${arrival}T00:00:00.000`,
          dateTo: `${departure}T00:00:00.000`
        },
        searchAccommodation: {
          searchLines: [
            {
              units: 1,
              adults,
              children: children.length,
              childrenAges: children
            }
          ]
        }
      }
    };
    const searchResp = await axios.post('https://webapi.deskline.net/searches', searchPayload, { headers });
    const searchId = searchResp.data?.id;
    if (!searchId) {
      return res.status(500).json({ error: 'Failed to initiate search', details: searchResp.data });
    }

    const fields = 'id,name';
    const servicesUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services/searchresults/${searchId}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1`;
    const servicesResp = await axios.get(servicesUrl, { headers });

    let items = Array.isArray(servicesResp.data) ? servicesResp.data : [];
    if (!Array.isArray(items)) {
      for (const key of Object.keys(servicesResp.data || {})) {
        if (Array.isArray(servicesResp.data[key])) {
          items = servicesResp.data[key];
          break;
        }
      }
    }
    if (!items.length) {
      return res.json({ offers: [] });
    }

    const productIds = items.map(item => item.id);
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units: 1,
      adults,
      childrenAges: children.join(',') || '',
      mealCode: '',
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };
    const priceUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;
    const priceResp = await axios.post(priceUrl, pricePayload, { headers });

    const priceLookup = {};
    if (Array.isArray(priceResp.data)) {
      priceResp.data.forEach(item => {
        const pid = item.productId;
        let total = 0;
        Object.values(item.data || {}).forEach(dayList => {
          dayList.forEach(entry => {
            if (entry && typeof entry.price === 'number') total += entry.price;
            if (entry?.additionalServices) {
              entry.additionalServices.forEach(s => {
                if (typeof s.price === 'number') total += s.price; // tax, cleaning
              });
            }
          });
        });
        priceLookup[pid] = { total, available: total > 0 };
      });
    }

    const offers = items.map(item => ({
      productId: item.id,
      name: item.name || '',
      totalPrice: priceLookup[item.id]?.total || 0,
      currency: 'EUR',
      availability: priceLookup[item.id]?.available || false,
      nights
    }));
    res.json({ offers });
  } catch (error) {
    console.error('Feratel API ERROR:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch data from Feratel', details: error.response?.data || error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Feratel proxy API running on port ${PORT}`));

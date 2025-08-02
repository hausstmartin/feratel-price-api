const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration values specific to your Feratel installation.
// Replace these with your own identifiers if they differ.
// The accommodation ID. Replace this with the correct ID for your property.
const accommodationId = '5edbae02-da8e-4489-8349-4bb836450b3e';
const destination = 'accbludenz';
const prefix = 'BLU';

// The productIds correspond to the “serviceIds” from your widget code.
const serviceIds = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

/**
 * Convert a date string (YYYY-MM-DD) into a Date object at midnight UTC.
 * @param {string} dateStr
 */
function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [] } = req.body;

  // Validate mandatory parameters
  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  // Compute number of nights between the dates
  const arrivalDate = toDate(arrival);
  const departureDate = toDate(departure);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const nights = Math.round((departureDate - arrivalDate) / millisecondsPerDay);
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  // Build request payload for Feratel API
  const payload = {
    productIds: serviceIds,
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

    // Prepare common headers for Feratel requests
    const headers = {
      'Content-Type': 'application/json',
      'DW-Source': 'dwapp-accommodation',
      'DW-SessionId': Date.now().toString(),
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://direct.bookingandmore.com',
      'Referer': 'https://direct.bookingandmore.com'
    };

    try {
      // Step 1: Create a search to obtain a searchId
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
      // Step 2: Retrieve service (room) results with price information
      const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
      const servicesUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services/searchresults/${searchId}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1`;
      const servicesResp = await axios.get(servicesUrl, { headers });
      // Determine the array of service items in the response. Different APIs may nest it differently.
      let items;
      const data = servicesResp.data;
      if (Array.isArray(data)) {
        items = data;
      } else if (data && typeof data === 'object') {
        // pick the first array property in the object
        for (const key of Object.keys(data)) {
          if (Array.isArray(data[key])) {
            items = data[key];
            break;
          }
        }
      }
      if (!items || !Array.isArray(items)) {
        return res.json({ offers: [] });
      }
      // Extract product IDs from the services to request detailed pricing
      const productIds = items.map(item => item.id);
      // Build payload for pricematrix endpoint
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
      // Construct URL for pricematrix for this accommodation
      const priceUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;
      let priceData = [];
      try {
        const priceResp = await axios.post(priceUrl, pricePayload, { headers });
        priceData = priceResp.data;
      } catch (priceErr) {
        console.error('Feratel API ERROR (pricematrix):', priceErr.response?.data || priceErr.message);
      }
      // Build a lookup for total price per productId
      const priceLookup = {};
      if (Array.isArray(priceData)) {
        priceData.forEach(item => {
          const pid = item.productId;
          let priceList = [];
          Object.values(item.data || {}).forEach(dayList => {
            dayList.forEach(entry => {
              if (typeof entry.price === 'number' && entry.price >= 0) {
                priceList.push(entry.price);
              }
            });
          });
          const total = priceList.reduce((sum, p) => sum + p, 0);
          priceLookup[pid] = {
            total,
            available: priceList.length === nights
          };
        });
      }
      const offers = items.map(item => {
        const pid = item.id;
        const priceInfo = priceLookup[pid] || { total: 0, available: false };
        return {
          productId: pid || '',
          name: item.name || '',
          totalPrice: priceInfo.total || 0,
          currency: 'EUR',
          availability: priceInfo.available,
          nights
        };
      });
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
  console.log(`Feratel proxy API running on port ${PORT}`);
});

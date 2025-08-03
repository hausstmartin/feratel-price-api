const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// Configuration values specific to your Feratel installation.
// These values should be customised to match your own environment.  If you
// deploy this proxy to production, consider moving them into environment
// variables rather than hard‑coding them here.
//
// The accommodation ID for Haus St. Martin.  Replace this with the correct
// identifier for your property if it differs.
const accommodationId = process.env.ACCOMMODATION_ID || '5edbae02-da8e-4489-8349-4bb836450b3e';
const destination = process.env.FERATEL_DESTINATION || 'accbludenz';
const prefix = process.env.FERATEL_PREFIX || 'BLU';

// The productIds correspond to the “serviceIds” from your widget code.  Keep
// this list in sync with the products you want to expose via the API.  If you
// add or remove rooms on your website, update this array accordingly.
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
  return new Date(`${dateStr}T00:00:00Z`);
}

/**
 * Generate a best‑effort session ID.  Feratel expects a valid DW‑SessionId
 * header on every request.  In production you should capture this from the
 * initial page load (e.g. via DevTools) or generate it via the official
 * shopping list endpoint.  As a fallback we use a timestamp‑based ID.
 */
function generateSessionId() {
  return process.env.DW_SESSION_ID || Date.now().toString();
}

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body;

  // Validate mandatory parameters
  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }
  if (units <= 0 || !Number.isInteger(units)) {
    return res.status(400).json({ error: 'Units must be a positive integer' });
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
    units,
    adults,
    childrenAges: children.join(',') || '',
    mealCode: '',
    currency: 'EUR',
    nightsRange: 0,
    arrivalRange: 0
  };

  // Prepare common headers for Feratel requests.  DW‑Source should match the
  // module used by the official application.  If your environment uses a
  // different value (e.g. 'haus-bludenz'), override it via environment variable.
  const headers = {
    'Content-Type': 'application/json',
    'DW-Source': process.env.DW_SOURCE || 'dwapp-accommodation',
    'DW-SessionId': generateSessionId(),
    'Accept': 'application/json, text/plain, */*',
    // Set Origin/Referer to emulate calls from your public site.  These
    // properties may not be strictly required but help mimic a browser.
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };

  try {
    // Step 1: Create a search to obtain a searchId.  This initial call
    // establishes the context (DW‑SessionId) and returns a token used
    // to retrieve available services with pricing.
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
    const searchResp = await axios.post('https://webapi.deskline.net/searches', searchPayload, { headers });
    const searchId = searchResp.data?.id;
    if (!searchId) {
      return res.status(500).json({ error: 'Failed to initiate search', details: searchResp.data });
    }
    // Step 2: Retrieve service (room) results with price information
    const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services/searchresults/${searchId}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1`;
    const servicesResp = await axios.get(servicesUrl, { headers });
    // Determine the array of service items in the response.  Different APIs may
    // nest it differently.  We inspect the returned JSON for the first array.
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
    const offers = items.map(item => {
      const totalPrice = item?.fromPrice?.value ?? 0;
      return {
        productId: item.id || '',
        name: item.name || '',
        totalPrice,
        currency: 'EUR',
        availability: totalPrice > 0,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feratel proxy API running on port ${PORT}`);
});

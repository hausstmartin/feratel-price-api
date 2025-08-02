const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration values specific to your Feratel installation.
// Replace these with your own identifiers if they differ.
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
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

  // Construct endpoint URL using destination, language (en), prefix and accommodation ID
  const apiUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/pricematrix`;

  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        // Feratel expects a DW-Source header identifying the app making the request.
        'DW-Source': 'dwapp-accommodation',
        // Feratel also requires a DW-SessionId header; a timestamp string works as a unique ID.
        'DW-SessionId': Date.now().toString(),
        // Optional but recommended headers based on HAR capture
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://direct.bookingandmore.com',
        'Referer': 'https://direct.bookingandmore.com'
      }
    });

    // Aggregate prices for each product
    const offers = response.data.map(({ productId, data }) => {
      const priceList = [];
      // The API returns an object keyed by the number of units (usually "1").
      Object.values(data).forEach(dayList => {
        dayList.forEach(entry => {
          // Only consider valid prices (price >= 0)
          if (typeof entry.price === 'number' && entry.price >= 0) {
            priceList.push(entry.price);
          }
        });
      });
      const totalPrice = priceList.reduce((sum, p) => sum + p, 0);
      return {
        productId,
        totalPrice,
        currency: 'EUR',
        availability: priceList.length === nights,
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

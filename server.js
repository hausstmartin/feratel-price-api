const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// Configuration.  Replace these with your own identifiers or set them via
// environment variables.
const ACCOMMODATION_ID = process.env.ACCOMMODATION_ID || '5edbae02-da8e-4489-8349-4bb836450b3e';
const DESTINATION = process.env.FERATEL_DESTINATION || 'accbludenz';
const PREFIX = process.env.FERATEL_PREFIX || 'BLU';

// Helper to generate or retrieve a DW‑SessionId.  Feratel expects this to
// remain consistent across requests.  Use the environment variable
// DW_SESSION_ID to supply a stable value captured from your browser.  As a
// fallback, a timestamp‑based ID is used.
function getSessionId() {
  return process.env.DW_SESSION_ID || Date.now().toString();
}

// Fetch all rooms (services) from Deskline API.  Returns an array of
// rooms/services with metadata including names, descriptions, images and
// pricing information.  See API docs for details.
async function fetchRooms() {
  const url = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}/services?fields=id,name,description,rooms,bedrooms,size,order,images(sizes:[55,56,54],types:[13]){imagesFields...,description},fromPrice{value,calcRule,calcDuration},products{id,name,price{min,max,dailyPrice}}&currency=EUR&pageNo=1`;
  const resp = await axios.get(url);
  return resp.data;
}

// Retrieve precise prices and availability for the given productIds.  The
// function accepts the start date, number of nights, adults, children ages and
// units (number of rooms) and returns the raw response from the pricematrix
// endpoint.  Pass a custom DW‑Source and DW‑SessionId via environment
// variables if required by your Feratel installation.
async function fetchPrices(productIds, fromDate, nights, adults, childrenAges, units) {
  const pricePayload = {
    productIds,
    fromDate: `${fromDate}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges: childrenAges.join(','),
    mealCode: '',
    currency: 'EUR',
    nightsRange: 0,
    arrivalRange: 0
  };
  const headers = {
    'Content-Type': 'application/json',
    'DW-Source': process.env.DW_SOURCE || 'dwapp-accommodation',
    'DW-SessionId': getSessionId(),
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
  const url = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}/pricematrix`;
  const resp = await axios.post(url, pricePayload, { headers });
  return resp.data;
}

// Main endpoint.  Accepts arrival, departure, adults, children, units and
// returns offers with total price, availability, and additional metadata.
app.post('/get-price', async (req, res) => {
  try {
    const { arrival, departure, adults = 2, children = [], units = 1 } = req.body;
    if (!arrival || !departure) {
      return res.status(400).json({ error: 'Missing arrival/departure' });
    }
    const arrivalDate = new Date(arrival);
    const departureDate = new Date(departure);
    const nights = Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));
    if (nights <= 0) {
      return res.status(400).json({ error: 'Departure must be after arrival' });
    }
    if (!Number.isInteger(units) || units <= 0) {
      return res.status(400).json({ error: 'Units must be a positive integer' });
    }

    // 1. Fetch all rooms/services
    const services = await fetchRooms();
    const rooms = (services?.services || services) ?? [];
    const productIds = rooms.map(room => room.id);

    // 2. Get price matrix for the rooms
    const priceMatrix = await fetchPrices(productIds, arrival, nights, adults, children, units);

    // 3. Join room metadata with pricing information
    const result = rooms.map(room => {
      // Find price data for this room
      let priceData;
      if (Array.isArray(priceMatrix)) {
          priceData = priceMatrix.find(p => p.productId === room.id);
      }
      // Sum prices for each day in the matrix
      let totalPrice = 0;
      if (priceData?.data) {
        Object.values(priceData.data).forEach(dayArr => {
          dayArr.forEach(day => {
            if (typeof day.price === 'number') totalPrice += day.price;
          });
        });
      }
      return {
        id: room.id,
        name: room.name,
        description: room.description,
        images: room.images,
        size: room.size,
        maxPersons: room.maxPersons,
        minPersons: room.minPersons,
        totalPrice,
        currency: 'EUR',
        availability: !!(priceData && totalPrice > 0),
        nights
      };
    });
    res.json({ offers: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port', PORT));

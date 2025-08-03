const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Konfigurace pro Haus St. Martin
const accommodationId = process.env.ACCOMMODATION_ID || '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination = process.env.DESTINATION || 'accbludenz';
const prefix = process.env.PREFIX || 'BLU';

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Feratel Price API is running!',
    version: '1.0.0',
    accommodation: 'Haus St. Martin'
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({ 
    message: 'Server is working!',
    timestamp: new Date().toISOString()
  });
});

// Main price endpoint
app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [] } = req.body;

  // Validace
  if (!arrival || !departure) {
    return res.status(400).json({ 
      error: 'Missing required parameters',
      required: ['arrival', 'departure'],
      example: {
        arrival: '2024-03-15',
        departure: '2024-03-18',
        adults: 2,
        children: []
      }
    });
  }

  const arrivalDate = toDate(arrival);
  const departureDate = toDate(departure);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const nights = Math.round((departureDate - arrivalDate) / millisecondsPerDay);
  
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  try {
    console.log(`Processing request: ${arrival} to ${departure}, ${adults} adults, ${children.length} children`);

    // Vytvoření vyhledávání
    const searchPayload = {
      searchObject: {
        searchGeneral: {
          dateFrom: `${arrival}T00:00:00.000`,
          dateTo: `${departure}T00:00:00.000`
        },
        searchAccommodation: {
          searchLines: [{
            units: 1,
            adults,
            children: children.length,
            childrenAges: children
          }]
        }
      }
    };

    const searchResp = await axios.post('https://webapi.deskline.net/searches', searchPayload, { headers });
    const searchId = searchResp.data?.id;
    
    if (!searchId) {
      console.error('Failed to get search ID:', searchResp.data);
      return res.status(500).json({ error: 'Failed to initiate search' });
    }

    console.log(`Search ID obtained: ${searchId}`);

    // Získání služeb s cenami
    const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}/services/searchresults/${searchId}?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1`;
    
    const servicesResp = await axios.get(servicesUrl, { headers });

    let items;
    const data = servicesResp.data;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          items = data[key];
          break;
        }
      }
    }

    if (!items || !Array.isArray(items)) {
      console.log('No items found in response');
      return res.json({ 
        offers: [],
        message: 'No rooms available for selected dates'
      });
    }

    console.log(`Found ${items.length} rooms`);

    const offers = items.map(item => ({
      productId: item.id || '',
      name: item.name || 'Unknown Room',
      totalPrice: item?.fromPrice?.value ?? 0,
      currency: 'EUR',
      availability: (item?.fromPrice?.value ?? 0) > 0,
      nights,
      pricePerNight: item?.fromPrice?.value ? Math.round((item.fromPrice.value / nights) * 100) / 100 : 0
    }));

    const availableOffers = offers.filter(offer => offer.availability);
    
    res.json({ 
      offers: availableOffers,
      totalRooms: items.length,
      availableRooms: availableOffers.length,
      searchParams: {
        arrival,
        departure,
        nights,
        adults,
        children
      }
    });

  } catch (error) {
    console.error('Feratel API ERROR:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch data from Feratel',
      details: error.response?.data || error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: ['GET /', 'GET /test', 'POST /get-price']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${accommodationId}`);
  console.log(`🏨 Destination: ${destination}`);
});

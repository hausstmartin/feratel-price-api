const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Základní konfigurace
const ACCOMMODATION_ID = '5edbae02-da8e-4489-8349-4bb836450b3e';
const DESTINATION = 'accbludenz';
const PREFIX = 'BLU';

// Všechny pokoje načteme z Deskline API
async function fetchRooms() {
  const url = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}/services?fields=id,name,description,rooms,bedrooms,size,order,images(sizes:[55,56,54],types:[13]){imagesFields...,description},fromPrice{value,calcRule,calcDuration},products{id,name,price{min,max,dailyPrice}}&currency=EUR&pageNo=1`;
  const resp = await axios.get(url);
  return resp.data;
}

// Vrací přesné ceny a dostupnost pro konkrétní pokoje (productIds)
async function fetchPrices(productIds, fromDate, nights, adults, childrenAges) {
  const pricePayload = {
    productIds,
    fromDate: fromDate + "T00:00:00.000",
    nights,
    units: 1,
    adults,
    childrenAges: childrenAges.join(','),
    mealCode: '',
    currency: 'EUR',
    nightsRange: 0,
    arrivalRange: 0
  };
  const headers = {
    'Content-Type': 'application/json',
    'DW-Source': 'dwapp-accommodation',
    'DW-SessionId': Date.now().toString(),
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://direct.bookingandmore.com',
    'Referer': 'https://direct.bookingandmore.com'
  };
  const url = `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}/pricematrix`;
  const resp = await axios.post(url, pricePayload, { headers });
  return resp.data;
}

// Hlavní endpoint
app.post('/get-price', async (req, res) => {
  try {
    const { arrival, departure, adults = 2, children = [] } = req.body;
    if (!arrival || !departure) return res.status(400).json({ error: 'Missing arrival/departure' });
    const nights = Math.round((new Date(departure) - new Date(arrival)) / (1000 * 60 * 60 * 24));
    if (nights <= 0) return res.status(400).json({ error: 'Departure must be after arrival' });

    // 1. Načti všechny pokoje
    const services = await fetchRooms();
    const rooms = (services?.services || services) ?? [];
    const productIds = rooms.map(room => room.id);

    // 2. Zjisti přesné ceny z pricematrix
    const priceMatrix = await fetchPrices(productIds, arrival, nights, adults, children);

    // 3. Sestav odpověď (propoj informace a ceny)
    const result = rooms.map(room => {
      // Najdi cenu z pricematrix
      const priceData = Array.isArray(priceMatrix)
        ? priceMatrix.find(p => p.productId === room.id)
        : null;
      // Suma všech cen za každý den pobytu
      let totalPrice = 0;
      if (priceData?.data) {
        Object.values(priceData.data).forEach(dayArr => {
          dayArr.forEach(day => {
            if (typeof day.price === 'number') totalPrice += day.price;
          });
        });
      }
      // Sestav položku
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
        availability: !!(priceData && totalPrice > 0)
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

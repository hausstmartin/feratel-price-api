const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults, children = [], pets = 0 } = req.body;

  const payload = {
    accommodationId: '2e5f1399-f975-45c4-b384-fca5f5beee5e',
    context: {
      serviceIds: [
        '495ff768-31df-46d6-86bb-4511f038b2df',
        '37f364f3-26ed-4a20-b696-72f8ef69c00f',
        'a375e1af-83bc-4aed-b506-a37d1b31f531',
        '799a77bc-9fd3-4be5-b715-28f9fd51c864',
        '2c36e072-ba93-45c0-ae6c-98188964e386',
        '5bf8f190-b5bd-4941-aa50-71ca6564b045'
      ],
      productIds: [],
      packageIds: []
    },
    stay: {
      arrival,
      departure,
      adults,
      children,
      pets
    },
    lang: 'en'
  };

  try {
    const response = await axios.post(
      'https://web5.deskline.net/start/api/offerings/search',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://direct.bookingandmore.com',
          'Referer': 'https://direct.bookingandmore.com'
        }
      }
    );

    const offers = response.data.offerings.map(o => ({
      name: o.name,
      totalPrice: o.totalPrice.amount,
      currency: o.totalPrice.currency,
      availability: o.availability,
      nights: o.stay?.nights || null
    }));

    res.json({ offers });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch data from Feratel' });
  }
});

app.listen(3000, () => console.log('Feratel proxy API running on port 3000'));
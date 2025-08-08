const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Nastavení základního URL a Accommodation ID
const ACCOMMODATION_ID = '5edbae02-da8e-4489-8349-4bb836450b3e';
const BASE_URL = `https://webapi.deskline.net/accbludenz/en/accommodations/BLU/${ACCOMMODATION_ID}`;

app.post('/offers', async (req, res) => {
    const sessionId = `P${Date.now()}`;
    const debug = { sessionId, steps: [], input: req.body };

    try {
        const arrival = req.body.fromDate;
        const nights = req.body.nights;
        const departureDate = new Date(arrival);
        departureDate.setDate(departureDate.getDate() + nights);

        // 1️⃣ CREATE SEARCH
        const searchPayload = {
            searchObject: {
                searchGeneral: {
                    dateFrom: arrival,
                    dateTo: departureDate.toISOString()
                },
                searchAccommodation: {
                    searchLines: [
                        {
                            units: req.body.units || 1,
                            adults: req.body.adults || 2,
                            children: 0,
                            childrenAges: ""
                        }
                    ]
                }
            }
        };

        const searchResp = await axios.post(`${BASE_URL}/searches`, searchPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        const searchId = searchResp.data.id || searchResp.data.searchId;
        debug.steps.push({
            step: 'createSearch',
            status: searchResp.status,
            searchId,
            searchPayload
        });

        // 2️⃣ FETCH PRODUCT NAMES + DETAILS
        const namesUrl = `${BASE_URL}/services?fields=id%2Cname%2Csize%2Crooms%2Cbedrooms%2Cpersons%2Cchildren%2CmaxChildrenCount%2CfreeCancellation&currency=EUR&searchId=${searchId}`;
        const namesResp = await axios.get(namesUrl);
        debug.steps.push({
            step: 'fetchNames',
            status: namesResp.status,
            count: namesResp.data?.data?.length || 0
        });

        const productDetails = {};
        namesResp.data?.data?.forEach(entry => {
            entry.products.forEach(prod => {
                productDetails[prod.id] = {
                    name: prod.name,
                    size: prod.size || null,
                    roomsCount: prod.rooms || null,
                    bedroomsCount: prod.bedrooms || null,
                    maxPersons: prod.persons || null,
                    freeCancellation: prod.freeCancellation || false
                };
            });
        });

        const productIds = Object.keys(productDetails);

        // 3️⃣ FETCH PRICE MATRIX
        const pricePayload = {
            productIds,
            fromDate: arrival,
            nights: nights,
            units: req.body.units || 1,
            adults: req.body.adults || 2,
            childrenAges: "",
            mealCode: "",
            currency: "EUR",
            nightsRange: 1,
            arrivalRange: 1
        };

        const priceResp = await axios.post(`${BASE_URL}/pricematrix`, pricePayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        debug.steps.push({
            step: 'pricematrix',
            status: priceResp.status
        });

        const offers = productIds.map(pid => {
            const priceData = priceResp.data?.[pid] || {};
            let totalPrice = 0;
            let available = false;
            let pricePerNightBreakdown = [];

            if (priceData[`${nights}`]) {
                pricePerNightBreakdown = priceData[`${nights}`].map(p => ({
                    date: p.date,
                    price: p.price,
                    bookableStatus: p.bookableStatus
                }));
                totalPrice = pricePerNightBreakdown.reduce((sum, p) => sum + p.price, 0);
                available = pricePerNightBreakdown.every(p => p.bookableStatus === 0 || p.bookableStatus === 1);
            }

            return {
                productId: pid,
                ...productDetails[pid],
                totalPrice,
                currency: "EUR",
                availability: available,
                nights,
                pricePerNightBreakdown
            };
        });

        res.json({
            offers,
            debug: {
                accommodationId: ACCOMMODATION_ID,
                baseUrl: BASE_URL,
                ...debug
            }
        });

    } catch (error) {
        console.error("Error fetching offers:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to fetch offers", details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

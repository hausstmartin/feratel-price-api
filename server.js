const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const FERATEL_BASE =
  "https://webapi.deskline.net/accbludenz/en/accommodations/BLU";
const DW_SOURCE = "dwapp-accommodation";

/**
 * Helper pro logování requestů a jejich výsledků
 */
async function fetchWithLog(method, url, data) {
  let response;
  try {
    if (method === "GET") {
      response = await axios.get(url);
    } else if (method === "POST") {
      response = await axios.post(url, data, {
        headers: { "Content-Type": "application/json" },
      });
    }
    return { status: response.status, data: response.data, url };
  } catch (err) {
    return {
      status: err.response?.status || 500,
      data: err.response?.data || err.message,
      url,
    };
  }
}

app.post("/search", async (req, res) => {
  const arrival = req.body.arrival;
  const departure = req.body.departure;
  const units = req.body.units || 1;
  const adults = req.body.adults || 2;
  const childrenAges = Array.isArray(req.body.childrenAges)
    ? req.body.childrenAges
    : [];

  const nights =
    (new Date(departure) - new Date(arrival)) / (1000 * 60 * 60 * 24);

  const debug = {
    dwSource: DW_SOURCE,
    input: {
      arrival,
      departure,
      lines: [
        {
          units,
          adults,
          childrenAges,
        },
      ],
      totals: {
        units,
        adults,
        childrenAges,
      },
      nights,
    },
    servicesTried: [],
  };

  try {
    // 1️⃣ Získání SearchId
    const searchUrl = `${FERATEL_BASE}/search`;
    const searchResp = await fetchWithLog("POST", searchUrl, {
      arrival: `${arrival}T00:00:00`,
      departure: `${departure}T00:00:00`,
      lines: [
        {
          units,
          adults,
          childrenAges, // vždy pole
        },
      ],
      currency: "EUR",
    });
    debug.servicesTried.push({
      url: searchResp.url,
      status: searchResp.status,
    });

    if (!searchResp.data?.searchId) {
      throw new Error("SearchId not returned from Feratel");
    }

    const searchId = searchResp.data.searchId;
    debug.searchId = searchId;

    // 2️⃣ Získání seznamu produktů (id + name)
    const productsUrl = `${FERATEL_BASE}/products?fields=id,name&searchId=${searchId}&currency=EUR&pageNo=1&pageSize=100`;
    const productsResp = await fetchWithLog("GET", productsUrl);
    debug.servicesTried.push({
      url: productsResp.url,
      status: productsResp.status,
    });

    const products = productsResp.data?.items || [];
    debug.productsCount = products.length;

    if (products.length === 0) {
      throw new Error("No products found");
    }

    // 3️⃣ Získání cen z priceMatrix
    const priceMatrixUrl = `${FERATEL_BASE}/pricematrix`;
    const priceMatrixResp = await fetchWithLog("POST", priceMatrixUrl, {
      productIds: products.map((p) => p.id),
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units,
      adults,
      childrenAges, // pole, ne string
      mealCode: null,
      currency: "EUR",
      nightsRange: 0,
      arrivalRange: 0,
    });
    debug.servicesTried.push({
      url: priceMatrixResp.url,
      status: priceMatrixResp.status,
    });

    const matrixRows = priceMatrixResp.data?.rows || [];
    debug.gotMatrixRows = matrixRows.length;

    // 4️⃣ Mapování výsledků
    const offers = products.map((p) => {
      const row = matrixRows.find((r) => r.productId === p.id);
      return {
        productId: p.id,
        name: p.name || "",
        totalPrice: row?.total?.amount || 0,
        currency: row?.total?.currency || "EUR",
        availability: !!row,
        nights,
      };
    });

    res.json({ offers, debug });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch data from Feratel",
      details:
        err.response?.data || err.message || "Unknown error during API call",
    });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

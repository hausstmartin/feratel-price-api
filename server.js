// server.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ====== KONFIGURACE ======
const ACCOMMODATION_ID = process.env.FERATEL_ACCOMMODATION_ID || '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const DESTINATION      = process.env.FERATEL_DESTINATION      || 'accbludenz';
const PREFIX           = process.env.FERATEL_PREFIX           || 'BLU';

// DW-Source – ověřená hodnota z produkčního widgetu
const DW_SOURCE =
  process.env.DW_SOURCE ||
  'dwapp-accommodation'; // <- tohle fungovalo v tvých logách

// Fallback serviceIds, kdyby /services nic nevrátilo (Feratel občas vrátí prázdno bez chyby)
const FALLBACK_SERVICE_IDS = [
  '495ff768-31df-46d6-86bb-4511f038b2df',
  '37f364f3-26ed-4a20-b696-72f8ef69c00f',
  'a375e1af-83bc-4aed-b506-a37d1b31f531',
  '799a77bc-9fd3-4be5-b715-28f9fd51c864',
  '2c36e072-ba93-45c0-ae6c-98188964e386',
  '5bf8f190-b5bd-4941-aa50-71ca6564b045'
];

// Pomocné
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const isPosInt = (x) => Number.isInteger(x) && x >= 0;

// ====== Normalizace vstupu ======
/**
 * Vrátí:
 *  - searchLines: [{ units, adults, children, childrenAges }]
 *  - childrenAgesFlat: všechny dětské věky z celého požadavku v jednom poli (pro pricematrix → CSV)
 *  - unitsTotal: součet units přes všechny lines (pro kontrolu/debug)
 */
function normalizeOccupancy(body) {
  // 1) Pokročilý tvar – array „occupancies“
  if (Array.isArray(body.occupancies) && body.occupancies.length > 0) {
    const lines = [];
    let agesFlat = [];
    let unitsTotal = 0;

    for (const occ of body.occupancies) {
      const units = Number(occ.units ?? 1);
      const adultsPerUnit = Number(occ.adultsPerUnit ?? occ.adults ?? 2);

      // childrenAgesPerUnit může být:
      //  - jednorozměrné pole (pro 1 dítě v každé jednotce stejného věku)
      //  - pole polí (pro různé věky v jedné jednotce)
      let childrenAgesPerUnit = occ.childrenAgesPerUnit;
      if (!Array.isArray(childrenAgesPerUnit)) {
        // fallback: zkus childrenAges nebo prázdné
        childrenAgesPerUnit = occ.childrenAges || [];
      }
      // Znormalizovat na 2D pole: [ [4,8], [5], ... ] pro „units“ kusů
      if (childrenAgesPerUnit.length > 0 && !Array.isArray(childrenAgesPerUnit[0])) {
        // je to jednorozměrné → použij stejně pro každou jednotku
        childrenAgesPerUnit = Array.from({ length: units }, () => childrenAgesPerUnit);
      }

      for (let i = 0; i < units; i++) {
        const ages = (childrenAgesPerUnit[i] || []).map(Number).filter((n) => isPosInt(n) && n <= 17);
        lines.push({
          units: 1,
          adults: adultsPerUnit,
          children: ages.length,
          childrenAges: ages
        });
        agesFlat = agesFlat.concat(ages);
      }
      unitsTotal += units;
    }
    return { searchLines: lines, childrenAgesFlat: agesFlat, unitsTotal };
  }

  // 2) Jednoduchý tvar – „units“, „adults“, „childrenAges“
  const units = Number(body.units ?? 1);
  const adults = Number(body.adults ?? 2);
  const ages = (Array.isArray(body.childrenAges) ? body.childrenAges : body.children || [])
    .map(Number)
    .filter((n) => isPosInt(n) && n <= 17);

  const line = {
    units: isPosInt(units) && units > 0 ? units : 1,
    adults: isPosInt(adults) ? adults : 2,
    children: ages.length,
    childrenAges: ages
  };
  return { searchLines: [line], childrenAgesFlat: ages, unitsTotal: line.units };
}

/** Bezpečné pole → CSV string (pro /pricematrix) */
function toCsv(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.join(',');
}

/** Vybalí první pole z „podivného“ JSONu (Feratel to občas balí do objektu s náhodným klíčem) */
function firstArrayIn(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k])) return obj[k];
    }
  }
  return [];
}

// ====== HEADERS ======
function feratelHeaders(sessionId = Date.now().toString()) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'DW-Source': DW_SOURCE,          // <- klíčová hlavička
    'DW-SessionId': sessionId,
    Origin: 'https://direct.bookingandmore.com',
    Referer: 'https://direct.bookingandmore.com'
  };
}

// ====== ENDPOINT ======
app.post('/get-price', async (req, res) => {
  try {
    const { arrival, departure } = req.body || {};
    if (!arrival || !departure) {
      return res.status(400).json({ error: 'Missing arrival or departure date' });
    }

    const nights = Math.round((toDate(departure) - toDate(arrival)) / MS_PER_DAY);
    if (!Number.isFinite(nights) || nights <= 0) {
      return res.status(400).json({ error: 'Departure date must be after arrival date' });
    }

    // Normalizace obsazenosti
    const { searchLines, childrenAgesFlat } = normalizeOccupancy(req.body);

    // 1) /searches → searchId (SEZNAM LINEK)
    const headers = feratelHeaders();
    const searchPayload = {
      searchObject: {
        searchGeneral: {
          dateFrom: `${arrival}T00:00:00.000`,
          dateTo: `${departure}T00:00:00.000`
        },
        searchAccommodation: {
          searchLines: searchLines.map((l) => ({
            units: l.units,                        // POZOR: u searches jsou units v každé lince
            adults: l.adults,
            children: l.children,
            childrenAges: l.childrenAges           // <- pole čísel (tady to Feratel chce jako Array)
          }))
        }
      }
    };

    const searchResp = await axios.post('https://webapi.deskline.net/searches', searchPayload, { headers });
    const searchId = searchResp?.data?.id;
    if (!searchId) {
      return res.status(502).json({ error: 'Failed to initiate search', details: searchResp?.data || null });
    }

    // 2) /services?fields=…&searchId=…
    const fields = 'id,name,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice}';
    const servicesUrl =
      `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}` +
      `/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;

    const servicesResp = await axios.get(servicesUrl, { headers });
    const services = firstArrayIn(servicesResp.data);

    // Jestli nic – použij fallback IDs
    let productIds = services.map((s) => s.id).filter(Boolean);
    if (productIds.length === 0) productIds = [...FALLBACK_SERVICE_IDS];

    // 3) /pricematrix
    // !!! childrenAges musí být STRING CSV (ne pole) – jinak chyby s EndArray
    const pricePayload = {
      productIds,
      fromDate: `${arrival}T00:00:00.000`,
      nights,
      units: searchLines.reduce((sum, l) => sum + (Number(l.units) || 0), 0) || 1, // celkový součet units
      adults: searchLines.reduce((sum, l) => sum + (Number(l.adults) || 0) * (Number(l.units) || 1), 0), // jen pro debug/telemetrii na straně Feratel
      childrenAges: toCsv(childrenAgesFlat), // <--- KLÍČOVÁ ÚPRAVA
      mealCode: null,
      currency: 'EUR',
      nightsRange: 0,
      arrivalRange: 0
    };

    const priceUrl =
      `https://webapi.deskline.net/${DESTINATION}/en/accommodations/${PREFIX}/${ACCOMMODATION_ID}/pricematrix`;

    const priceResp = await axios.post(priceUrl, pricePayload, { headers });
    const matrix = Array.isArray(priceResp.data) ? priceResp.data : [];

    // 4) Vytvořit lookup productId → součet ceny (vč. additional services)
    const priceByProduct = {};
    for (const row of matrix) {
      const pid = row.productId;
      let total = 0;
      let countedNights = 0;

      const daysObj = row.data || {};
      for (const dayKey of Object.keys(daysObj)) {
        const dayList = Array.isArray(daysObj[dayKey]) ? daysObj[dayKey] : [];
        for (const entry of dayList) {
          if (typeof entry?.price === 'number') {
            total += entry.price;
            countedNights += 1;
          }
          if (Array.isArray(entry?.additionalServices)) {
            for (const svc of entry.additionalServices) {
              if (typeof svc?.price === 'number') total += svc.price;
            }
          }
        }
      }

      priceByProduct[pid] = {
        total,
        available: countedNights >= nights && total > 0
      };
    }

    // 5) Výstup
    const offers = productIds.map((pid) => {
      const meta = services.find((s) => s.id === pid) || {};
      const price = priceByProduct[pid] || { total: 0, available: false };
      return {
        productId: pid,
        name: meta.name || '',
        totalPrice: price.total,
        currency: 'EUR',
        availability: price.available,
        nights
      };
    });

    return res.json({
      offers,
      debug: {
        dwSource: DW_SOURCE,
        gotServices: services.length,
        gotMatrix: matrix.length
      }
    });
  } catch (err) {
    // Přehledná chyba
    const details = err?.response?.data || err?.message || 'Unknown error';
    console.error('Feratel API ERROR:', details);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details });
  }
});

// ====== START ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
  console.log(`📍 Accommodation: ${ACCOMMODATION_ID}`);
  console.log(`🏨 Destination: ${DESTINATION}`);
});

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---- Feratel config ----
const accommodationId = '2e5f1399-f975-45c4-b384-fca5f5beee5e';
const destination = 'accbludenz';
const prefix = 'BLU';

// Fallback product IDs pokud /services nic nevrátí
const FALLBACK_PRODUCT_IDS = [
  "b4265783-9c09-44e0-9af1-63ad964d64b9",
  "bda33d85-729b-40ca-ba2b-de4ca5e5841b",
  "78f0ede7-ce03-4806-8556-0d627bff27de",
  "bdd9a73d-7429-4610-9347-168b4b2785d8",
  "980db5a5-ac66-49f3-811f-0da67cc4a972",
  "0d0ae603-3fd9-4abd-98e8-eea813fd2d89"
];

const FERATEL_BASE = `https://webapi.deskline.net/${destination}/en/accommodations/${prefix}/${accommodationId}`;
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'DW-Source': 'dwapp-accommodation',
  'DW-SessionId': Date.now().toString(),
  'Origin': 'https://direct.bookingandmore.com',
  'Referer': 'https://direct.bookingandmore.com'
};

// ---- Helpery ----
function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function numberOrZero(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function sumEntryPrice(e) {
  return numberOrZero(e?.price) ||
         numberOrZero(e?.value) ||
         numberOrZero(e?.amount) ||
         numberOrZero(e?.dayPrice) ||
         numberOrZero(e?.total);
}

function sumAdditional(entry) {
  let extra = 0;
  if (Array.isArray(entry?.additionalServices)) {
    for (const s of entry.additionalServices) {
      extra += numberOrZero(s?.price);
    }
  }
  return extra;
}

// ---- API volání ----
async function createSearch({ arrival, departure, units, adults, childrenAges }) {
  const payload = {
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
            children: childrenAges.length,
            childrenAges: childrenAges
          }
        ]
      }
    }
  };
  const resp = await axios.post('https://webapi.deskline.net/searches', payload, { headers: HEADERS_BASE });
  return resp.data?.id || null;
}

async function fetchServices(searchId) {
  const fields = `id,usesAvailability,availablilities,name,description,rooms,bedrooms,size,order,images(sizes:[55,56,54],types:[13]){imagesFields...},layout{layoutFields...},licenseNumber,links{name,url,order,type},documents{name,order,url},stars{level,name,url,image},classification{id,name,order,url,icon,image},criterias{groupId,groupName,items{id,name,value}},minPersons,maxPersons,fromPrice{value,calcRule,calcDuration,mealCode,isBestPrice,isSpecialPrice},products{id,isBookable,isOfferable,isBookableOnRequest,searchLine,name,owner,type,subType,description,occupancy{minAdults,maxAdults,minChildren,maxChildren,minBed,maxBed},images(count:10,sizes:[55,56,54]){imagesFields...},links{id,name,url,order,type},documents{id,name,order,url},price{min,max,calcRule,calcDuration,dailyPrice},priceDetails{priceDetailsFields...},possibleMeals{code,price},housePackageMaster{isNotRegulationPackage,validityPeriods{dateFrom,dateTo},contentLong,contentTitle,descriptions(types:[8]){description},images(count:10,sizes:[55,56,54]){imagesFields...}},paymentCancellationPolicy(paymentTypes:[1,0,2]){paymentPolicy{paymentMethods,depositCalculationRule,depositAmount,hasPrePaymentLink,textType,defaultHeaderText,defaultText},cancellationPolicy{hasFreeCancellation,lastFreeDate,lastFreeTime,cancellationTextType,defaultHeaderTextNumber,textLines{defaultTextNumber,cancellationCalculationType,cancellationNights,cancellationPercentage,hasFreeTime,cancellationDate,freeTime}}}},handicapFacilities{groupId,groupName,items{id,name,value,comment,handicapGroupIds}},handicapClassifications{id,name,order,icon,image}`;
  
  const url = `${FERATEL_BASE}/services?fields=${encodeURIComponent(fields)}&currency=EUR&pageNo=1&searchId=${encodeURIComponent(searchId)}`;
  
  const resp = await axios.get(url, { headers: HEADERS_BASE, validateStatus: false });
  const items = Array.isArray(resp.data) ? resp.data : (resp.data?.items || []);
  return items;
}

async function fetchPriceMatrix({ arrival, nights, units, adults, childrenAges, productIds }) {
  const payload = {
    productIds,
    fromDate: `${arrival}T00:00:00.000`,
    nights,
    units,
    adults,
    childrenAges: childrenAges.length ? childrenAges.join(',') : "",
    mealCode: "",
    currency: "EUR",
    nightsRange: 1,
    arrivalRange: 1
  };
  const url = `${FERATEL_BASE}/pricematrix`;
  const resp = await axios.post(url, payload, { headers: HEADERS_BASE });
  return { data: resp.data, payload, url };
}

// ---- Endpoint ----
app.post('/get-price', async (req, res) => {
  const { arrival, departure, adults = 2, children = [], units = 1 } = req.body || {};

  if (!arrival || !departure) {
    return res.status(400).json({ error: 'Missing arrival or departure date' });
  }

  const nights = Math.round((toDate(departure) - toDate(arrival)) / (24 * 60 * 60 * 1000));
  if (nights <= 0) {
    return res.status(400).json({ error: 'Departure date must be after arrival date' });
  }

  const childrenAges = (Array.isArray(children) ? children : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  const debug = {
    input: { arrival, departure, units, adults, childrenAges, nights }
  };

  try {
    const searchId = await createSearch({ arrival, departure, units, adults, childrenAges });
    debug.searchId = searchId;

    let services = await fetchServices(searchId);
    let productIds = [];

    if (Array.isArray(services) && services.length) {
      for (const s of services) {
        if (Array.isArray(s.products)) {
          for (const p of s.products) {
            if (p?.id) productIds.push(p.id);
          }
        }
      }
    }

    if (!productIds.length) {
      productIds = FALLBACK_PRODUCT_IDS;
      debug.usedFallback = true;
    }

    const { data: pmData, payload: sentPayload, url: priceUrl } = await fetchPriceMatrix({
      arrival, nights, units, adults, childrenAges, productIds
    });

    debug.pricePayload = sentPayload;
    debug.priceUrl = priceUrl;

    let matrixRows = Array.isArray(pmData) ? pmData : [];
    const priceLookup = {};

    for (const row of matrixRows) {
      const pid = row?.productId;
      if (!pid) continue;
      let total = 0;
      let nightsCounted = 0;
      for (const day of Object.values(row.data || {})) {
        if (Array.isArray(day)) {
          for (const e of day) {
            const base = sumEntryPrice(e);
            const extra = sumAdditional(e);
            if (base > 0 || extra > 0) {
              total += base + extra;
              nightsCounted++;
            }
          }
        }
      }
      priceLookup[pid] = { total, nightsCounted };
    }

    const offers = productIds.map(pid => ({
      productId: pid,
      totalPrice: priceLookup[pid]?.total || 0,
      currency: 'EUR',
      availability: (priceLookup[pid]?.nightsCounted || 0) >= nights,
      nights
    }));

    return res.json({ offers, debug });
  } catch (err) {
    console.error('Feratel API ERROR:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to fetch data from Feratel', details: err.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Feratel Price API running on port ${PORT}`);
});

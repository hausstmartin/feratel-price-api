// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = "https://webapi.deskline.net/accbludenz/en/accommodations/BLU";
const DW_SOURCE = "dwapp-accommodation";

/**
 * Helper pro bezpečné fetch s fallbackem
 */
async function safeFetch(url, options = {}, fallback = null) {
    try {
        const res = await fetch(url, options);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.trim() === "" || res.status === 204) {
            if (fallback) return fallback;
            throw new Error(`Empty response from ${url}`);
        }
        return JSON.parse(text);
    } catch (err) {
        console.error("Fetch error:", url, err.message);
        return fallback;
    }
}

app.post("/search", async (req, res) => {
    const { arrival, departure, lines } = req.body;

    // Přepočítáme počty
    const totals = lines.reduce(
        (acc, line) => {
            acc.units += line.units || 0;
            acc.adults += line.adults || 0;
            if (Array.isArray(line.childrenAges)) {
                acc.childrenAges.push(...line.childrenAges);
            }
            return acc;
        },
        { units: 0, adults: 0, childrenAges: [] }
    );

    const nights =
        (new Date(departure).getTime() - new Date(arrival).getTime()) /
        (1000 * 60 * 60 * 24);

    let debug = {
        dwSource: DW_SOURCE,
        input: { arrival, departure, lines, totals, nights }
    };

    try {
        // 1) SearchId
        const searchUrl = `${BASE_URL}/services?fields=id,name&currency=EUR&pageNo=1&pageSize=100&arrival=${arrival}&departure=${departure}&adults=${totals.adults}`;
        const servicesData = await safeFetch(searchUrl, {}, { items: [] });
        debug.servicesTried = [{ url: searchUrl, status: servicesData?.items?.length ? 200 : 204 }];

        let productIds = [];
        let productNamesMap = {};

        if (servicesData?.items?.length) {
            productIds = servicesData.items.map(i => i.id);
            servicesData.items.forEach(item => {
                productNamesMap[item.id] = item.name || "";
            });
        }

        // Fallback: pokud nejsou IDs, zkusíme načíst z packages
        if (!productIds.length) {
            const packagesUrl = `${BASE_URL}/packages?fields=id,name,products{id,name}&currency=EUR&pageNo=1&pageSize=100`;
            const packagesData = await safeFetch(packagesUrl, {}, { items: [] });
            debug.servicesTried.push({ url: packagesUrl, status: packagesData?.items?.length ? 200 : 204 });

            packagesData.items?.forEach(pkg => {
                pkg.products?.forEach(prod => {
                    if (!productIds.includes(prod.id)) {
                        productIds.push(prod.id);
                        productNamesMap[prod.id] = prod.name || "";
                    }
                });
            });
        }

        debug.servicesUsed = productIds.length ? productIds : null;
        debug.servicesCount = productIds.length;
        debug.usedFallbackIds = !servicesData?.items?.length;

        // 2) Price matrix
        let priceMatrixPayload = {
            productIds,
            fromDate: new Date(arrival).toISOString(),
            nights,
            units: totals.units,
            adults: totals.adults,
            childrenAges: totals.childrenAges.length ? totals.childrenAges : [],
            mealCode: null,
            currency: "EUR",
            nightsRange: 0,
            arrivalRange: 0
        };

        debug.priceUrl = `${BASE_URL}/pricematrix`;
        debug.sentToPriceMatrix = { ...priceMatrixPayload, productIdsCount: productIds.length };

        const priceMatrix = await safeFetch(
            debug.priceUrl,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(priceMatrixPayload)
            },
            { rows: [] }
        );

        debug.gotMatrixRows = priceMatrix?.rows?.length || 0;

        // 3) Výsledek
        const offers = productIds.map(pid => {
            const row = priceMatrix.rows?.find(r => r.productId === pid);
            return {
                productId: pid,
                name: productNamesMap[pid] || "",
                totalPrice: row?.totalPrice?.value || 0,
                currency: row?.totalPrice?.currency || "EUR",
                availability: !!row,
                nights
            };
        });

        res.json({ offers, debug });
    } catch (error) {
        console.error("Main error:", error);
        res.status(500).json({
            error: "Failed to fetch data from Feratel",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

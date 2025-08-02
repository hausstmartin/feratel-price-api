# Feratel Price API Proxy

Express backend, který spojí všechny pokoje Haus St. Martin s aktuální cenou a dostupností pro zadané datum a počet osob.

## Jak použít

1. Deployni na Render.com (nebo localhost)
2. Pošli POST na `/get-price` s JSON:
   ```json
   {
     "arrival": "2026-02-03",
     "departure": "2026-02-07",
     "adults": 2,
     "children": []
   }

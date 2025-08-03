# Feratel Proxy Updates

This update introduces a new Express-based proxy (`feratel-proxy.js`) for querying the Feratel API. The proxy accepts `arrival`, `departure`, `adults`, `children`, and `units` parameters via JSON, validates them, establishes a search session with Feratel, and returns pricing and availability for the defined set of service IDs.

## Key Changes

* **Dynamic `units` parameter:** The number of units (rooms) is now read from the request body instead of being hard-coded. The server validates that `units` is a positive integer.
* **Configurable headers:** The proxy reads `DW-Source`, `DW-SessionId`, the accommodation ID, destination and prefix from environment variables if provided. This makes it easy to adjust the values without editing the code.
* **Session ID generation:** A helper function generates a session ID from an environment variable (`DW_SESSION_ID`) or uses the current timestamp as a fallback.
* **Payload and search updates:** Both the initial search (`/searches`) and the subsequent services query respect the `units`, `adults` and `children` values provided by the client.

## Usage

1. Install dependencies:
   ```bash
   npm install express axios
   ```

2. Configure environment variables as needed (optional):
   ```bash
   export ACCOMMODATION_ID="5edbae02-da8e-4489-8349-4bb836450b3e"
   export FERATEL_DESTINATION="accbludenz"
   export FERATEL_PREFIX="BLU"
   export DW_SOURCE="haus-bludenz"
   export DW_SESSION_ID="<copy from browser DevTools>"
   export PORT=3000
   ```

3. Start the proxy:
   ```bash
   # Pokud používáš feratel-proxy.js (starší název)
   node feratel-proxy.js
   # Nebo můžeš přímo spustit server.js v tomto balíčku
   node server.js
   ```

4. Send a POST request to `/get-price` with JSON payload:
   ```json
   {
     "arrival": "2026-02-03",
     "departure": "2026-02-07",
     "adults": 2,
     "units": 1,
     "children": []
   }
   ```

The server will return a JSON response with an `offers` array containing product IDs, room names, total price in EUR, availability flag and number of nights.


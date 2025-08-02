# Feratel Price Proxy API

This Node.js Express server acts as a proxy to fetch live pricing and availability from the Feratel booking system for Haus St. Martin.

## 🚀 How to Deploy (Render.com)

1. Create a GitHub repo (e.g., `feratel-price-api`)
2. Upload these 3 files (`server.js`, `package.json`, `README.md`)
3. Push to GitHub
4. Go to [https://dashboard.render.com](https://dashboard.render.com)
5. Click **New Web Service**
6. Choose your repo
7. Use:
   - Build Command: *(leave empty)*
   - Start Command: `node server.js`
   - Port: `3000`
8. Click **Deploy**

Once deployed, your endpoint will look like:
`https://<your-name>.onrender.com/get-price`

You can now connect it to your Custom GPT using OpenAPI.
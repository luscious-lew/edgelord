# Deploying Kalshi WebSocket Service

This guide helps you deploy the real-time WebSocket service to Railway or Render.

## Option 1: Railway (Recommended - Easiest)

Railway has excellent Deno support and is the simplest option.

### Steps:

1. **Install Railway CLI** (optional but helpful):
   ```bash
   npm i -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Create a new project**:
   ```bash
   railway init
   ```

4. **Set environment variables**:
   ```bash
   railway variables set SUPABASE_URL=https://hquevhjfozjqgciieqsl.supabase.co
   railway variables set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   railway variables set KALSHI_API_KEY_ID=your-kalshi-api-key-id
   railway variables set KALSHI_PRIVATE_KEY="$(cat /tmp/kalshi_key_pkcs8.pem)"
   ```

   Or via Railway Dashboard:
   - Go to your project → Variables
   - Add each variable

5. **Deploy**:
   ```bash
   railway up
   ```

   Railway will automatically detect Deno and run the service.

### Via Railway Dashboard (No CLI):

1. Go to https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Connect your GitHub repo
4. Railway will auto-detect the setup
5. Go to Settings → Variables and add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `KALSHI_API_KEY_ID`
   - `KALSHI_PRIVATE_KEY` (paste the full PEM key including headers)
6. Deploy!

---

## Option 2: Render

Render also supports Deno and is a good alternative.

### Steps:

1. **Go to Render Dashboard**: https://dashboard.render.com

2. **Create a new Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repo
   - Select the `edgelord` directory

3. **Configure**:
   - **Name**: `kalshi-websocket-stream`
   - **Environment**: `Docker`
   - **Dockerfile Path**: `Dockerfile.websocket`
   - **Start Command**: (leave empty, handled by Dockerfile)

4. **Set Environment Variables**:
   - `SUPABASE_URL` = `https://hquevhjfozjqgciieqsl.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = (your service role key)
   - `KALSHI_API_KEY_ID` = (your Kalshi API key ID)
   - `KALSHI_PRIVATE_KEY` = (paste full PEM key including headers)

5. **Deploy**:
   - Click "Create Web Service"
   - Render will build and deploy automatically

---

## Option 3: Fly.io (Alternative)

Fly.io also supports Deno well.

### Steps:

1. **Install Fly CLI**:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Login**:
   ```bash
   fly auth login
   ```

3. **Create app**:
   ```bash
   fly launch --no-deploy
   ```

4. **Set secrets**:
   ```bash
   fly secrets set SUPABASE_URL=https://hquevhjfozjqgciieqsl.supabase.co
   fly secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   fly secrets set KALSHI_API_KEY_ID=your-kalshi-api-key-id
   fly secrets set KALSHI_PRIVATE_KEY="$(cat /tmp/kalshi_key_pkcs8.pem)"
   ```

5. **Deploy**:
   ```bash
   fly deploy
   ```

---

## Verifying Deployment

Once deployed, check the logs:

**Railway**:
```bash
railway logs
```

**Render**: Go to Dashboard → Your Service → Logs

**Fly.io**:
```bash
fly logs
```

You should see:
- `🚀 Starting Kalshi WebSocket service...`
- `✅ Connected to Kalshi WebSocket`
- `📨 Received: market_update` (when updates come in)
- `✅ Updated TICKER` (when prices update)

---

## Monitoring

The service will:
- Automatically reconnect if the WebSocket disconnects
- Stream real-time price updates to your Supabase database
- Your UI will automatically update via Supabase Realtime

If the service crashes, Railway/Render will automatically restart it.

---

## Cost Estimates

- **Railway**: ~$5-10/month for hobby plan
- **Render**: Free tier available, then ~$7/month
- **Fly.io**: Free tier available, then pay-as-you-go

All are very affordable for a single WebSocket service.


# Railway Environment Variables Setup

## Issue: "Missing Supabase credentials"

This error means Railway isn't finding the environment variables. Here's how to fix it:

## Step-by-Step Fix

### 1. Check Variable Scope

Railway has two levels for environment variables:
- **Project-level**: Shared across all services
- **Service-level**: Specific to one service

Make sure your variables are set at the **service level** (on your WebSocket service).

### 2. Verify Variables Are Set

1. Go to Railway Dashboard
2. Click on your **WebSocket service** (not the project)
3. Go to **Variables** tab
4. Verify these 4 variables exist:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `KALSHI_API_KEY_ID`
   - `KALSHI_PRIVATE_KEY`

### 3. Check Variable Values

**SUPABASE_URL:**
- Should be: `https://hquevhjfozjqgciieqsl.supabase.co`
- No trailing slash
- No quotes

**SUPABASE_SERVICE_ROLE_KEY:**
- Get from: Supabase Dashboard → Settings → API → `service_role` key
- Should start with `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
- No quotes
- Copy the entire key

**KALSHI_API_KEY_ID:**
- Your Kalshi API Key ID
- No quotes

**KALSHI_PRIVATE_KEY:**
- Full PEM key including headers:
  ```
  -----BEGIN PRIVATE KEY-----
  MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDn0b/yOzYFfiuE
  ... (all lines)
  -----END PRIVATE KEY-----
  ```
- No quotes
- Include headers

### 4. Common Issues

**Issue: Variables set at project level but not service level**
- Solution: Set them on the service itself

**Issue: Extra quotes or spaces**
- Solution: Remove any quotes around values
- Remove leading/trailing spaces

**Issue: Variable name typo**
- Solution: Check exact spelling (case-sensitive)

**Issue: Service restarted but variables not applied**
- Solution: After setting variables, Railway should auto-redeploy. If not, manually redeploy.

### 5. Verify After Setting

After setting variables, check the logs. You should see:
```
Environment variables check:
- SUPABASE_URL: ✅ Set (XX chars)
- SUPABASE_SERVICE_ROLE_KEY: ✅ Set (XX chars)
- KALSHI_API_KEY_ID: ✅ Set (XX chars)
- KALSHI_PRIVATE_KEY: ✅ Set (XX chars)
```

If you see "❌ Missing", that variable isn't set correctly.

## Quick Test

To verify Railway can see your variables, temporarily add this to the start of your script:

```typescript
console.log("SUPABASE_URL:", Deno.env.get("SUPABASE_URL") ? "SET" : "NOT SET");
```

Then check the logs.


# Fixing Kalshi Private Key Format

## The Problem

Your `KALSHI_PRIVATE_KEY` secret appears to be in the wrong format. It should be a PEM-formatted RSA private key, not a hex string.

## What Kalshi Provides

Kalshi should provide you with:
1. **API Key ID** (already set correctly)
2. **Private Key** - This should be in PEM format

## Correct Format

Your private key should look like this:

```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bN1Kl8VrR3v1Z5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J
... (many more lines of base64) ...
-----END PRIVATE KEY-----
```

## Steps to Fix

1. **Get your private key from Kalshi Dashboard**
   - Log into your Kalshi account
   - Go to API settings
   - Copy the full private key (including headers)

2. **If Kalshi gave you a hex string or other format:**
   - Contact Kalshi support to get the PEM format
   - Or check their documentation for key format conversion

3. **If you have the key but it's PKCS#1 format:**
   ```bash
   # Save it to a file first
   echo "-----BEGIN RSA PRIVATE KEY-----
   (your key content)
   -----END RSA PRIVATE KEY-----" > kalshi-key.pem
   
   # Convert to PKCS#8
   openssl pkcs8 -topk8 -inform PEM -in kalshi-key.pem -outform PEM -nocrypt -out kalshi-key-pkcs8.pem
   ```

4. **Set it in Supabase:**
   ```bash
   npx supabase secrets set KALSHI_PRIVATE_KEY="$(cat kalshi-key-pkcs8.pem)"
   ```

## Verify

After setting the secret, test it:
```bash
curl -X POST https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

If you still get errors, the key format is still incorrect.


# Kalshi Private Key Format Check

If you're getting the error: `unexpected ASN.1 DER tag: expected SEQUENCE, got INTEGER`

This means your private key might be in the wrong format. The Web Crypto API requires PKCS#8 format.

## Check Your Key Format

Your private key should look like this:

```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
(multiple lines of base64)
...
-----END PRIVATE KEY-----
```

**NOT** like this (PKCS#1 format):
```
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...
-----END RSA PRIVATE KEY-----
```

## If Your Key is PKCS#1 Format

If Kalshi provided a PKCS#1 format key, you need to convert it to PKCS#8:

```bash
# Convert PKCS#1 to PKCS#8
openssl pkcs8 -topk8 -inform PEM -in rsakey.pem -outform PEM -nocrypt -out pkcs8-key.pem
```

## Setting the Key in Supabase

When setting the secret in Supabase, make sure to:
1. Include the full key including headers (`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`)
2. Keep all newlines intact (the key should span multiple lines)
3. Don't add extra spaces or characters

You can set it via CLI:
```bash
npx supabase secrets set KALSHI_PRIVATE_KEY="$(cat your-key.pem)"
```

Or via Dashboard: Project Settings → Edge Functions → Secrets


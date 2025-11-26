/**
 * Kalshi API Authentication Helper
 * 
 * Kalshi uses RSA-PSS signature authentication. Each request requires:
 * - KALSHI-ACCESS-KEY: Your API Key ID
 * - KALSHI-ACCESS-TIMESTAMP: Current timestamp in milliseconds
 * - KALSHI-ACCESS-SIGNATURE: RSA-PSS signature of timestamp + method + path
 */

/**
 * Generates authentication headers for Kalshi API requests
 * @param method HTTP method (GET, POST, etc.)
 * @param path Request path (e.g., "/trade-api/v2/markets")
 * @returns Headers object with Kalshi authentication headers
 */
export async function getKalshiAuthHeaders(
  method: string,
  path: string
): Promise<Headers> {
  const apiKeyId = Deno.env.get("KALSHI_API_KEY_ID");
  const privateKeyPem = Deno.env.get("KALSHI_PRIVATE_KEY");

  if (!apiKeyId) {
    throw new Error("Missing KALSHI_API_KEY_ID environment variable");
  }
  if (!privateKeyPem) {
    throw new Error("Missing KALSHI_PRIVATE_KEY environment variable");
  }

  // Validate private key format
  if (!privateKeyPem.includes("BEGIN") && !privateKeyPem.includes("PRIVATE")) {
    console.warn("Warning: Private key doesn't appear to be in PEM format. Make sure it includes -----BEGIN PRIVATE KEY----- header.");
  }

  // Generate timestamp in milliseconds
  const timestamp = Date.now().toString();

  // Create the message to sign: timestamp + method + path
  const message = timestamp + method.toUpperCase() + path;

  // Import the private key - try both formats
  let privateKey: CryptoKey;
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  
  try {
    // Try PKCS#8 format first
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBuffer,
      {
        name: "RSA-PSS",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );
  } catch (error) {
    // If PKCS#8 fails, try PKCS#1 format
    // Note: Web Crypto API doesn't directly support PKCS#1, so we might need to convert it
    // For now, throw a more helpful error
    throw new Error(
      `Failed to import private key. Make sure it's in PKCS#8 format (-----BEGIN PRIVATE KEY-----). ` +
      `Error: ${error.message}`
    );
  }

  // Sign the message
  const signature = await crypto.subtle.sign(
    {
      name: "RSA-PSS",
      saltLength: 32,
    },
    privateKey,
    new TextEncoder().encode(message)
  );

  // Base64 encode the signature
  const signatureB64 = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  );

  // Create headers
  const headers = new Headers();
  headers.set("KALSHI-ACCESS-KEY", apiKeyId);
  headers.set("KALSHI-ACCESS-TIMESTAMP", timestamp);
  headers.set("KALSHI-ACCESS-SIGNATURE", signatureB64);
  headers.set("Content-Type", "application/json");

  return headers;
}

/**
 * Converts PEM format private key to ArrayBuffer for Web Crypto API
 * Handles both PKCS#8 (PRIVATE KEY) and PKCS#1 (RSA PRIVATE KEY) formats
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Normalize the PEM string - remove all whitespace first
  let normalizedPem = pem.replace(/\s+/g, '');
  
  // Try PKCS#8 format first (-----BEGIN PRIVATE KEY-----)
  let pemHeader = "-----BEGINPRIVATEKEY-----";
  let pemFooter = "-----ENDPRIVATEKEY-----";
  let keyFormat: "pkcs8" | "pkcs1" = "pkcs8";
  
  if (normalizedPem.includes(pemHeader)) {
    normalizedPem = normalizedPem.replace(pemHeader, "").replace(pemFooter, "");
  } else {
    // Try PKCS#1 format (-----BEGIN RSA PRIVATE KEY-----)
    pemHeader = "-----BEGINRSAPRIVATEKEY-----";
    pemFooter = "-----ENDRSAPRIVATEKEY-----";
    if (normalizedPem.includes(pemHeader)) {
      normalizedPem = normalizedPem.replace(pemHeader, "").replace(pemFooter, "");
      keyFormat = "pkcs1";
    } else {
      // Try with spaces in header/footer
      normalizedPem = pem.trim();
      if (normalizedPem.includes("BEGIN PRIVATE KEY")) {
        normalizedPem = normalizedPem
          .replace(/-----BEGIN PRIVATE KEY-----/g, "")
          .replace(/-----END PRIVATE KEY-----/g, "")
          .replace(/\s/g, "");
      } else if (normalizedPem.includes("BEGIN RSA PRIVATE KEY")) {
        normalizedPem = normalizedPem
          .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
          .replace(/-----END RSA PRIVATE KEY-----/g, "")
          .replace(/\s/g, "");
        keyFormat = "pkcs1";
      } else {
        // Assume it's already base64 without headers
        normalizedPem = normalizedPem.replace(/\s/g, "");
      }
    }
  }

  // Base64 decode
  const binaryString = atob(normalizedPem);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return bytes.buffer;
}


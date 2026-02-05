#!/bin/bash
# Script to verify and convert Kalshi private key to PKCS#8 format

echo "🔍 Checking key format..."

KEY_FILE="${1:-/tmp/kalshi_key_pkcs8.pem}"

if [ ! -f "$KEY_FILE" ]; then
    echo "❌ Key file not found: $KEY_FILE"
    echo "Usage: $0 [path-to-key-file]"
    exit 1
fi

echo "📄 Key file: $KEY_FILE"
echo ""
echo "First line of key:"
head -1 "$KEY_FILE"
echo ""

if grep -q "BEGIN PRIVATE KEY" "$KEY_FILE"; then
    echo "✅ Key is in PKCS#8 format (correct!)"
    echo ""
    echo "📋 Full key (copy this to Railway):"
    echo "---"
    cat "$KEY_FILE"
    echo "---"
elif grep -q "BEGIN RSA PRIVATE KEY" "$KEY_FILE"; then
    echo "❌ Key is in PKCS#1 format (wrong!)"
    echo ""
    echo "Converting to PKCS#8 format..."
    CONVERTED_FILE="${KEY_FILE%.*}_converted.pem"
    openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in "$KEY_FILE" -out "$CONVERTED_FILE"
    
    if [ $? -eq 0 ]; then
        echo "✅ Converted successfully!"
        echo ""
        echo "📋 Converted key (copy this to Railway):"
        echo "---"
        cat "$CONVERTED_FILE"
        echo "---"
        echo ""
        echo "💾 Saved to: $CONVERTED_FILE"
    else
        echo "❌ Conversion failed. Make sure openssl is installed."
        exit 1
    fi
else
    echo "⚠️ Unknown key format"
    echo "First 100 characters:"
    head -c 100 "$KEY_FILE"
    echo ""
fi


#!/bin/bash
# Script to convert Kalshi private key from PKCS#1 to PKCS#8 format

echo "Kalshi Private Key Converter"
echo "============================"
echo ""
echo "This script will help you convert your Kalshi private key to the correct format."
echo ""

# Check if openssl is available
if ! command -v openssl &> /dev/null; then
    echo "Error: openssl is not installed. Please install it first."
    exit 1
fi

# Prompt for input file
read -p "Enter the path to your Kalshi private key file (or press Enter to create one): " input_file

if [ -z "$input_file" ]; then
    echo ""
    echo "Please paste your Kalshi private key (including headers)."
    echo "Press Ctrl+D when done:"
    echo ""
    input_file="/tmp/kalshi_key_temp.pem"
    cat > "$input_file"
fi

if [ ! -f "$input_file" ]; then
    echo "Error: File not found: $input_file"
    exit 1
fi

# Check if it's already PKCS#8
if grep -q "BEGIN PRIVATE KEY" "$input_file"; then
    echo ""
    echo "✓ Key appears to be in PKCS#8 format already!"
    echo ""
    echo "Your key:"
    echo "---"
    cat "$input_file"
    echo "---"
    echo ""
    echo "You can set this in Supabase with:"
    echo "npx supabase secrets set KALSHI_PRIVATE_KEY=\"\$(cat $input_file)\""
    exit 0
fi

# Check if it's PKCS#1
if grep -q "BEGIN RSA PRIVATE KEY" "$input_file"; then
    echo ""
    echo "Key is in PKCS#1 format. Converting to PKCS#8..."
    echo ""
    
    output_file="${input_file%.*}_pkcs8.pem"
    openssl pkcs8 -topk8 -inform PEM -in "$input_file" -outform PEM -nocrypt -out "$output_file"
    
    if [ $? -eq 0 ]; then
        echo "✓ Conversion successful!"
        echo ""
        echo "Converted key saved to: $output_file"
        echo ""
        echo "Your converted key:"
        echo "---"
        cat "$output_file"
        echo "---"
        echo ""
        echo "Set this in Supabase with:"
        echo "npx supabase secrets set KALSHI_PRIVATE_KEY=\"\$(cat $output_file)\""
    else
        echo "Error: Conversion failed. Please check your key file."
        exit 1
    fi
else
    echo ""
    echo "Warning: Could not determine key format."
    echo "Make sure your key file includes one of these headers:"
    echo "  - -----BEGIN PRIVATE KEY----- (PKCS#8)"
    echo "  - -----BEGIN RSA PRIVATE KEY----- (PKCS#1)"
    echo ""
    echo "File contents:"
    head -3 "$input_file"
fi


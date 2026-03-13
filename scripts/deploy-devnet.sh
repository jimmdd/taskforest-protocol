#!/bin/bash
set -e

# Load env
source .env

HELIUS_RPC="${HELIUS_DEVNET_RPC}"
WALLET="keys/taskforest.json"
PUBKEY=$(solana-keygen pubkey "$WALLET")

echo "=== TaskForest Devnet Deploy (Helius RPC) ==="
echo "Wallet:  $PUBKEY"
echo "RPC:     $HELIUS_RPC"
echo ""

# Check balance
BALANCE=$(solana balance "$PUBKEY" --url "$HELIUS_RPC" 2>/dev/null | awk '{print $1}')
echo "Balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 3" | bc -l) )); then
  echo ""
  echo "⚠  Need at least 3 SOL for deploy. Attempting airdrop..."
  solana airdrop 2 "$PUBKEY" --url "$HELIUS_RPC" || {
    echo ""
    echo "Airdrop failed. Please fund manually:"
    echo "  → Visit https://faucet.solana.com"
    echo "  → Address: $PUBKEY"
    echo "  → Select Devnet, request 5 SOL"
    exit 1
  }
  sleep 2
  BALANCE=$(solana balance "$PUBKEY" --url "$HELIUS_RPC" 2>/dev/null | awk '{print $1}')
  echo "New balance: $BALANCE SOL"
fi

echo ""
echo "1. Configuring for devnet (Helius)..."
solana config set --url "$HELIUS_RPC" --keypair "$WALLET"

echo ""
echo "2. Syncing program keys..."
anchor keys sync

echo ""
echo "3. Building..."
anchor build

echo ""
echo "4. Deploying to devnet..."
anchor deploy --provider.cluster "$HELIUS_RPC" --provider.wallet "$WALLET"

echo ""
echo "5. Verifying deployment..."
solana program show $(anchor keys list | awk '{print $2}') --url "$HELIUS_RPC"

echo ""
echo "=== Deploy Complete ==="
echo ""
echo "Run ER integration test:"
echo "  ANCHOR_PROVIDER_URL=\$HELIUS_DEVNET_RPC ANCHOR_WALLET=keys/taskforest.json npx ts-mocha -p ./tsconfig.json -t 120000 tests/er-devnet.ts"

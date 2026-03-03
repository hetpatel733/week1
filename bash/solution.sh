#!/bin/bash
set -e

RPC_USER="alice"
RPC_PASS="your_password_here"  # CHANGE THIS!
RPC_PORT="18443"

# Make RPC calls
rpc() {
    local method=$1; shift
    curl -s --user "$RPC_USER:$RPC_PASS" \
        -H "Content-Type: application/json" \
        --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"bash\",\"method\":\"$method\",\"params\":[$@]}" \
        http://127.0.0.1:$RPC_PORT/ | jq -r '.result'
}

# RPC for wallet calls
wrpc() {
    local wallet=$1; local method=$2; shift 2
    curl -s --user "$RPC_USER:$RPC_PASS" \
        -H "Content-Type: application/json" \
        --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"bash\",\"method\":\"$method\",\"params\":[$@]}" \
        http://127.0.0.1:$RPC_PORT/wallet/$wallet | jq -r '.result'
}

# Create wallets
echo "Creating wallets..."
rpc "createwallet" '"Miner"' > /dev/null 2>&1 || true
rpc "createwallet" '"Trader"' > /dev/null 2>&1 || true

# Get Miner address and mine 101 blocks
echo "Mining 101 blocks..."
MINER_ADDR=$(wrpc Miner "getnewaddress" '"Mining Reward"')
rpc "generatetoaddress" "101" "\"$MINER_ADDR\"" > /dev/null

MINER_BALANCE=$(wrpc Miner "getbalance")
echo "Miner balance: $MINER_BALANCE BTC"

# Send 20 BTC from miner to trader
echo "Creating transaction..."
TRADER_ADDR=$(wrpc Trader "getnewaddress" '"Received"')
TXID=$(wrpc Miner "sendtoaddress" "\"$TRADER_ADDR\"" "20")
echo "Transaction ID: $TXID"

# Mine 1 block for confirmation
echo "Mining block for confirmation..."
BLOCK_HASH=$(rpc "generatetoaddress" "1" "\"$MINER_ADDR\"" | jq -r '.[0]')
BLOCK_HEIGHT=$(rpc "getblock" "\"$BLOCK_HASH\"" | jq -r '.height')

# Get transaction details
RAW_TX=$(rpc "getrawtransaction" "\"$TXID\"" "true")

# Write output
{
    echo "$TXID"
    echo "Trader received: $(echo "$RAW_TX" | jq -r ".vout[] | select(.scriptPubKey.address == \"$TRADER_ADDR\") | .value")"
    echo "Block Height: $BLOCK_HEIGHT"
    echo "Block Hash: $BLOCK_HASH"
} | tee out.txt

echo "Done!"
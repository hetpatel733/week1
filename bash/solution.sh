#!/bin/bash
set -e

RPC_USER="alice"
RPC_PASS=""
RPC_PORT="18443"

# Extract JSON value using grep/sed (works without jq)
json_extract() {
    local json="$1"
    local path="$2"
    echo "$json" | grep -o "\"$path\"[^,}]*" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | head -1
}

# Make RPC calls to bitcoind
rpc() {
    local method=$1; shift
    curl -s --user "$RPC_USER:$RPC_PASS" \
        -H "Content-Type: application/json" \
        --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"bash\",\"method\":\"$method\",\"params\":[$@]}" \
        http://127.0.0.1:$RPC_PORT/
}

# RPC for wallet calls
wrpc() {
    local wallet=$1; local method=$2; shift 2
    curl -s --user "$RPC_USER:$RPC_PASS" \
        -H "Content-Type: application/json" \
        --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"bash\",\"method\":\"$method\",\"params\":[$@]}" \
        http://127.0.0.1:$RPC_PORT/wallet/$wallet
}

# Creating wallets
rpc "createwallet" '"Miner"' > /dev/null
rpc "createwallet" '"Trader"' > /dev/null

# Get Miner address and mine 101 blocks to make the funds spendable
MINER_ADDR=$(wrpc Miner "getnewaddress" '"Mining Reward"' | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
rpc "generatetoaddress" "101" "\"$MINER_ADDR\"" > /dev/null

# Miner balance
MINER_BALANCE=$(wrpc Miner "getbalance" | grep -o '"result":[0-9.]*' | cut -d':' -f2)
echo "Miner balance: $MINER_BALANCE BTC"

# sending 20 BTC from miner to trader
TRADER_ADDR=$(wrpc Trader "getnewaddress" '"Received"' | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
TXID=$(wrpc Miner "sendtoaddress" "\"$TRADER_ADDR\"" "20" | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
echo "Transaction ID: $TXID"

# entry into mempool
echo "Mempool entry:"
MEMPOOL_ENTRY=$(rpc "getmempoolentry" "\"$TXID\"")
echo "$MEMPOOL_ENTRY" | grep -o '"result":{[^}]*}' | sed 's/"result"://'

# Mining 1 block for confirmation
BLOCK_HASH=$(rpc "generatetoaddress" "1" "\"$MINER_ADDR\"" | grep -o '"[a-f0-9]\{64\}"' | tr -d '"' | head -1)
BLOCK_HEIGHT=$(rpc "getblock" "\"$BLOCK_HASH\"" | grep -o '"height":[0-9]*' | cut -d':' -f2)

# Get transaction input and output
RAW_TX=$(rpc "getrawtransaction" "\"$TXID\"" "true")
PREV_TXID=$(echo "$RAW_TX" | grep -o '"txid":"[^"]*"' | head -1 | cut -d'"' -f4)
PREV_VOUT=$(echo "$RAW_TX" | grep -o '"vout":[0-9]*' | head -1 | cut -d':' -f2)
PREV_TX=$(rpc "getrawtransaction" "\"$PREV_TXID\"" "true")

# Extract input address and amount from previous transaction
MINER_INPUT_ADDR=$(echo "$PREV_TX" | grep -o '"address":"[^"]*"' | sed -n "$((PREV_VOUT+1))p" | cut -d'"' -f4)
MINER_INPUT_AMOUNT=$(echo "$PREV_TX" | grep -o '"value":[0-9.]*' | sed -n "$((PREV_VOUT+1))p" | cut -d':' -f2)

# Extract outputs
TRADER_AMOUNT=$(echo "$RAW_TX" | grep -B2 "\"address\":\"$TRADER_ADDR\"" | grep -o '"value":[0-9.]*' | cut -d':' -f2)
CHANGE_ADDR=$(echo "$RAW_TX" | grep -o '"address":"[^"]*"' | cut -d'"' -f4 | grep -v "$TRADER_ADDR" | head -1)
CHANGE_AMOUNT=$(echo "$RAW_TX" | grep -B2 "\"address\":\"$CHANGE_ADDR\"" | grep -o '"value":[0-9.]*' | cut -d':' -f2)

# Calculate transaction fee using awk instead of bc
TX_FEE=$(awk "BEGIN {printf \"%.8f\", $MINER_INPUT_AMOUNT - $TRADER_AMOUNT - $CHANGE_AMOUNT}")

# Write output file
cat > out.txt << EOF
$TXID
$MINER_INPUT_ADDR
$MINER_INPUT_AMOUNT
$TRADER_ADDR
$TRADER_AMOUNT
$CHANGE_ADDR
$CHANGE_AMOUNT
$TX_FEE
$BLOCK_HEIGHT
$BLOCK_HASH
EOF

echo "Done! out.txt:"
cat out.txt
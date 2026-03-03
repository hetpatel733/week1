#!/bin/bash
set -e

RPC_USER="alice"
RPC_PASS=""
RPC_PORT="18443"

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

# Createing wallets
rpc "createwallet" '"Miner"' > /dev/null
rpc "createwallet" '"Trader"' > /dev/null

# Get Miner address and mine 101 blocks to make the funds spent
MINER_ADDR=$(wrpc Miner "getnewaddress" '"Mining Reward"' | jq -r '.result')
rpc "generatetoaddress" "101" "\"$MINER_ADDR\"" > /dev/null

# Miner balance
MINER_BALANCE=$(wrpc Miner "getbalance" | jq -r '.result')
echo "Miner balance: $MINER_BALANCE BTC"

# sending 20 BTC from miner to trader
TRADER_ADDR=$(wrpc Trader "getnewaddress" '"Received"' | jq -r '.result')
TXID=$(wrpc Miner "sendtoaddress" "\"$TRADER_ADDR\"" "20" | jq -r '.result')
echo "Transaction ID: $TXID"

# entry into memepool
echo "Mempool entry:"
rpc "getmempoolentry" "\"$TXID\"" | jq '.result'

# Mining 1 block for confimation
BLOCK_HASH=$(rpc "generatetoaddress" "1" "\"$MINER_ADDR\"" | jq -r '.result[0]')
BLOCK_HEIGHT=$(rpc "getblock" "\"$BLOCK_HASH\"" | jq -r '.result.height')

# Get transaction input and output
RAW_TX=$(rpc "getrawtransaction" "\"$TXID\"" "true")
PREV_TXID=$(echo "$RAW_TX" | jq -r '.result.vin[0].txid')
PREV_VOUT=$(echo "$RAW_TX" | jq -r '.result.vin[0].vout')
PREV_TX=$(rpc "getrawtransaction" "\"$PREV_TXID\"" "true")

MINER_INPUT_ADDR=$(echo "$PREV_TX" | jq -r ".result.vout[$PREV_VOUT].scriptPubKey.address")
MINER_INPUT_AMOUNT=$(echo "$PREV_TX" | jq -r ".result.vout[$PREV_VOUT].value")

VOUTS=$(echo "$RAW_TX" | jq -r '.result.vout')
TRADER_AMOUNT=$(echo "$VOUTS" | jq -r ".[] | select(.scriptPubKey.address == \"$TRADER_ADDR\") | .value")
CHANGE_ADDR=$(echo "$VOUTS" | jq -r ".[] | select(.scriptPubKey.address != \"$TRADER_ADDR\") | .scriptPubKey.address")
CHANGE_AMOUNT=$(echo "$VOUTS" | jq -r ".[] | select(.scriptPubKey.address != \"$TRADER_ADDR\") | .value")

TX_FEE=$(echo "$MINER_INPUT_AMOUNT - $TRADER_AMOUNT - $CHANGE_AMOUNT" | bc)

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
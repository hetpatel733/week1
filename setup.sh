#!/bin/bash

#downloading Bitcoin core from official source
echo "Downloading Bitcoin Core 27.1..."
wget https://bitcoincore.org/bin/bitcoin-core-27.1/bitcoin-27.1-x86_64-linux-gnu.tar.gz -O /tmp/bitcoin.tar.gz

#extracting the archive to tmp directory
echo "Extracting archive..."
tar -xzf /tmp/bitcoin.tar.gz -C /tmp/

# Making the binaries available in system Path 

echo "Installing binaries to /usr/local/bin..."
sudo cp /tmp/bitcoin-27.1/bin/bitcoind /usr/local/bin/
sudo cp /tmp/bitcoin-27.1/bin/bitcoin-cli /usr/local/bin/


#arranging the bitcoin.conf with provided requirements
mkdir -p ~/.bitcoin
cat > ~/.bitcoin/bitcoin.conf << 'EOF'
regtest=1
fallbackfee=0.0001
server=1
rest=1
txindex=1
rpcauth=alice:88cae77e34048eff8b9f0be35527dd91$d5c4e7ff4dfe771808e9c00a1393b90d498f54dcab0ee74a2d77bd01230cd4cc
EOF

echo "bitcoin.conf created at ~/.bitcoin/bitcoin.conf"

#starting the bitcoind in daemon
echo "Starting bitcoind in daemon mode..."
bitcoind -daemon

sleep 5
echo "Bitcoin node started successfully!"
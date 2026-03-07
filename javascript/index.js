const Client = require('bitcoin-core');
const fs = require('fs');
const path = require('path');

const baseConfig = {
    network: 'regtest',
    username: 'alice',
    password: 'password',
    host: '127.0.0.1',
    port: 18443
};

const client = new Client(baseConfig);

function getWalletClient(walletName) {
    return new Client({ ...baseConfig, wallet: walletName });
}

async function loadOrCreateWallet(name) {
    try {
        await client.command('loadwallet', name);
        console.log(`Wallet '${name}' loaded`);
    } catch (e) {
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('already loaded')) {
            console.log(`Wallet '${name}' already loaded`);
        } else {
            try {
                await client.command('createwallet', name, false, false, '', false, false);
                console.log(`Wallet '${name}' created (legacy)`);
            } catch (createErr) {
                const cMsg = (createErr.message || '').toLowerCase();
                if (cMsg.includes('already exists') || cMsg.includes('database already exists')) {
                    await client.command('loadwallet', name);
                    console.log(`Wallet '${name}' loaded (existing)`);
                } else {
                    try {
                        await client.command('createwallet', name);
                        console.log(`Wallet '${name}' created (descriptor)`);
                    } catch (e2) {
                        const e2Msg = (e2.message || '').toLowerCase();
                        if (e2Msg.includes('already exists') || e2Msg.includes('database already exists')) {
                            await client.command('loadwallet', name);
                            console.log(`Wallet '${name}' loaded (existing)`);
                        } else {
                            throw e2;
                        }
                    }
                }
            }
        }
    }
}

// Extract the private key expression from a wallet's descriptor for a given address
async function getPrivKeyExpr(walletClient, addr) {
    const addrInfo = await walletClient.command('getaddressinfo', addr);
    const hdkeypath = addrInfo.hdkeypath; // e.g. "m/44'/1'/0'/0/5"
    const pathParts = hdkeypath.split('/');
    const keyIndex = pathParts[pathParts.length - 1]; // e.g. "5"

    // Get all private descriptors from the wallet
    const descList = await walletClient.command('listdescriptors', true);

    // Find the external pkh descriptor (used for legacy addresses)
    const pkhDesc = descList.descriptors.find(d =>
        d.desc.startsWith('pkh(') && d.active && !d.internal
    );
    if (!pkhDesc) throw new Error('Could not find pkh descriptor');

    // Extract the key expression from pkh(KEY_EXPR)#checksum
    const descStr = pkhDesc.desc;
    const keyExpr = descStr.slice(descStr.indexOf('(') + 1, descStr.lastIndexOf(')'));
    // keyExpr is like: [fingerprint/44h/1h/0h]tprv8.../0/*

    // Replace the wildcard * with the specific key index
    return keyExpr.replace('*', keyIndex);
}

async function main() {
    const blockchainInfo = await client.getBlockchainInfo();
    console.log('Blockchain Info:', blockchainInfo);

    await loadOrCreateWallet('Miner');
    await loadOrCreateWallet('Alice');
    await loadOrCreateWallet('Bob');

    const miner = getWalletClient('Miner');
    const alice = getWalletClient('Alice');
    const bob = getWalletClient('Bob');

    // Mine blocks for spendable balance
    const minerAddress = await miner.getNewAddress();
    const currentBlocks = (await client.getBlockchainInfo()).blocks;
    if (currentBlocks < 103) {
        await client.command('generatetoaddress', 103 - currentBlocks, minerAddress);
    }
    let minerBalance = await miner.getBalance();
    while (minerBalance < 150) {
        console.log(`Miner balance ${minerBalance} BTC, mining more blocks...`);
        await client.command('generatetoaddress', 3, minerAddress);
        minerBalance = await miner.getBalance();
    }
    console.log(`Miner balance: ${minerBalance} BTC`);

    // Fund Alice and Bob with 15 BTC each
    const aliceFundAddress = await alice.getNewAddress();
    const bobFundAddress = await bob.getNewAddress();
    await miner.sendToAddress(aliceFundAddress, 15);
    await miner.sendToAddress(bobFundAddress, 15);
    await client.command('generatetoaddress', 6, minerAddress);
    console.log(`Alice balance after funding: ${await alice.getBalance()} BTC`);
    console.log(`Bob balance after funding: ${await bob.getBalance()} BTC`);

    // Get public keys from legacy addresses
    const aliceKeyAddr = await alice.getNewAddress('', 'legacy');
    const bobKeyAddr = await bob.getNewAddress('', 'legacy');
    const alicePubKey = (await alice.getAddressInfo(aliceKeyAddr)).pubkey;
    const bobPubKey = (await bob.getAddressInfo(bobKeyAddr)).pubkey;
    console.log(`Alice pubkey: ${alicePubKey}`);
    console.log(`Bob pubkey: ${bobPubKey}`);

    // Extract private key expressions for multisig descriptor import
    const alicePrivKeyExpr = await getPrivKeyExpr(alice, aliceKeyAddr);
    const bobPrivKeyExpr = await getPrivKeyExpr(bob, bobKeyAddr);

    // Create 2-of-2 P2WSH multisig address
    const multisigResult = await client.command('createmultisig', 2, [alicePubKey, bobPubKey], 'bech32');
    const multisigAddress = multisigResult.address;
    const witnessScript = multisigResult.redeemScript;
    console.log(`Multisig P2WSH address: ${multisigAddress}`);
    console.log(`Witness script: ${witnessScript}`);

    // Import multisig descriptors WITH private keys into each wallet
    // Alice's wallet: Alice's private key + Bob's public key
    const multiDescAlice = `wsh(multi(2,${alicePrivKeyExpr},${bobPubKey}))`;
    const multiInfoAlice = await client.command('getdescriptorinfo', multiDescAlice);
    const multiDescAliceWithCS = multiDescAlice + '#' + multiInfoAlice.checksum;
    await alice.command('importdescriptors', [{ desc: multiDescAliceWithCS, timestamp: 'now' }]);

    // Bob's wallet: Alice's public key + Bob's private key
    const multiDescBob = `wsh(multi(2,${alicePubKey},${bobPrivKeyExpr}))`;
    const multiInfoBob = await client.command('getdescriptorinfo', multiDescBob);
    const multiDescBobWithCS = multiDescBob + '#' + multiInfoBob.checksum;
    await bob.command('importdescriptors', [{ desc: multiDescBobWithCS, timestamp: 'now' }]);
    console.log('Multisig descriptors with private keys imported into Alice and Bob wallets');

    // Build funding PSBT
    const aliceUTXOs = await alice.command('listunspent');
    const bobUTXOs = await bob.command('listunspent');
    const aliceUTXO = aliceUTXOs.find(u => u.amount >= 10);
    const bobUTXO = bobUTXOs.find(u => u.amount >= 10);
    if (!aliceUTXO || !bobUTXO) throw new Error('Insufficient UTXOs for Alice or Bob');

    const totalInput = aliceUTXO.amount + bobUTXO.amount;
    const multisigAmount = 20;
    const fundingFee = 0.0002;
    const changeEach = parseFloat(((totalInput - multisigAmount - fundingFee) / 2).toFixed(8));

    const aliceChangeAddress = await alice.getNewAddress();
    const bobChangeAddress = await bob.getNewAddress();

    const fundingInputs = [
        { txid: aliceUTXO.txid, vout: aliceUTXO.vout },
        { txid: bobUTXO.txid, vout: bobUTXO.vout }
    ];
    const fundingOutputs = [
        { [multisigAddress]: multisigAmount },
        { [aliceChangeAddress]: changeEach },
        { [bobChangeAddress]: changeEach }
    ];

    let fundingPsbt = await client.command('createpsbt', fundingInputs, fundingOutputs);
    fundingPsbt = await client.command('utxoupdatepsbt', fundingPsbt);

    const aliceFundSigned = await alice.command('walletprocesspsbt', fundingPsbt);
    const bobFundSigned = await bob.command('walletprocesspsbt', fundingPsbt);

    const combinedFunding = await client.command('combinepsbt', [aliceFundSigned.psbt, bobFundSigned.psbt]);
    const finalizedFunding = await client.command('finalizepsbt', combinedFunding);
    if (!finalizedFunding.complete) throw new Error('Funding PSBT could not be finalized');

    const fundingTxId = await client.sendRawTransaction(finalizedFunding.hex);
    console.log(`Funding TX ID: ${fundingTxId}`);

    await client.command('generatetoaddress', 6, minerAddress);
    console.log('Mined 6 blocks to confirm funding transaction');
    console.log(`Alice balance: ${await alice.getBalance()} BTC`);
    console.log(`Bob balance: ${await bob.getBalance()} BTC`);

    // Build spending PSBT
    const fundingTxDetails = await client.command('getrawtransaction', fundingTxId, true);
    let multisigVout = -1;
    for (let i = 0; i < fundingTxDetails.vout.length; i++) {
        const out = fundingTxDetails.vout[i];
        if (Math.abs(out.value - multisigAmount) < 0.00001 &&
            out.scriptPubKey.type === 'witness_v0_scripthash') {
            multisigVout = i;
            break;
        }
    }
    if (multisigVout === -1) throw new Error('Multisig UTXO not found in funding transaction');

    const aliceReceiveAddress = await alice.getNewAddress();
    const bobReceiveAddress = await bob.getNewAddress();
    const spendingFee = 0.0002;
    const eachReceives = parseFloat(((multisigAmount - spendingFee) / 2).toFixed(8));

    const spendingInputs = [{ txid: fundingTxId, vout: multisigVout }];
    const spendingOutputs = [
        { [aliceReceiveAddress]: eachReceives },
        { [bobReceiveAddress]: eachReceives }
    ];

    // Create spending PSBT and update with multisig descriptor for witness script
    let spendingPsbt = await client.command('createpsbt', spendingInputs, spendingOutputs);
    spendingPsbt = await client.command('utxoupdatepsbt', spendingPsbt, [multiInfoAlice.descriptor]);

    // Both wallets sign (they now have private keys for the multisig)
    const aliceSpendSigned = await alice.command('walletprocesspsbt', spendingPsbt, true, 'ALL');
    const bobSpendSigned = await bob.command('walletprocesspsbt', spendingPsbt, true, 'ALL');

    const combinedSpending = await client.command('combinepsbt', [aliceSpendSigned.psbt, bobSpendSigned.psbt]);
    const finalizedSpending = await client.command('finalizepsbt', combinedSpending);
    if (!finalizedSpending.complete) throw new Error('Spending PSBT could not be finalized');

    const spendingTxId = await client.sendRawTransaction(finalizedSpending.hex);
    console.log(`Spending TX ID: ${spendingTxId}`);

    await client.command('generatetoaddress', 6, minerAddress);
    console.log('Mined 6 blocks to confirm spending transaction');
    console.log(`Final Alice balance: ${await alice.getBalance()} BTC`);
    console.log(`Final Bob balance: ${await bob.getBalance()} BTC`);

    // Debug: print witness data for verification
    const spendingTxDetails = await client.command('getrawtransaction', spendingTxId, true);
    const witness = spendingTxDetails.vin[0].txinwitness;
    console.log('Witness stack:');
    witness.forEach((w, i) => console.log(`  [${i}]: ${w.substring(0, 20)}... (${w.length / 2} bytes)`));

    fs.writeFileSync(path.join(__dirname, '..', 'out.txt'), `${fundingTxId}\n${spendingTxId}\n`);
    console.log('Results written to out.txt');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
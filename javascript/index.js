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
    } catch (e) {
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('already loaded')) {
            // already loaded - so just proceed ahead
        } else {
            try {
                await client.command('createwallet', name, false, false, '', false, false);
            } catch (createErr) {
                const cMsg = (createErr.message || '').toLowerCase();
                if (cMsg.includes('already exists') || cMsg.includes('database already exists')) {
                    await client.command('loadwallet', name);
                } else {
                    try {
                        await client.command('createwallet', name);
                    } catch (e2) {
                        const e2Msg = (e2.message || '').toLowerCase();
                        if (e2Msg.includes('already exists') || e2Msg.includes('database already exists')) {
                            await client.command('loadwallet', name);
                        } else {
                            throw e2;
                        }
                    }
                }
            }
        }
    }
}

// Extract private key expression from wallet's descriptor for a given address
async function getPrivKeyExpr(walletClient, addr) {
    const addrInfo = await walletClient.command('getaddressinfo', addr);
    const hdkeypath = addrInfo.hdkeypath;
    const pathParts = hdkeypath.split('/');
    const keyIndex = pathParts[pathParts.length - 1];

    // Get all private descriptors from the wallet
    const descList = await walletClient.command('listdescriptors', true);

    // Find the external pkh descriptor
    const pkhDesc = descList.descriptors.find(d =>
        d.desc.startsWith('pkh(') && d.active && !d.internal
    );
    if (!pkhDesc) throw new Error('Could not find pkh descriptor');

    const descStr = pkhDesc.desc;
    const keyExpr = descStr.slice(descStr.indexOf('(') + 1, descStr.lastIndexOf(')'));

    return keyExpr.replace('*', keyIndex);
}

async function main() {
    await client.getBlockchainInfo();

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
        await client.command('generatetoaddress', 3, minerAddress);
        minerBalance = await miner.getBalance();
    }

    // Fund Alice and Bob with 15 BTC each
    const aliceFundAddress = await alice.getNewAddress();
    const bobFundAddress = await bob.getNewAddress();
    await miner.sendToAddress(aliceFundAddress, 15);
    await miner.sendToAddress(bobFundAddress, 15);
    await client.command('generatetoaddress', 6, minerAddress);

    // Get public keys from legacy addresses
    const aliceKeyAddr = await alice.getNewAddress('', 'legacy');
    const bobKeyAddr = await bob.getNewAddress('', 'legacy');
    const alicePubKey = (await alice.getAddressInfo(aliceKeyAddr)).pubkey;
    const bobPubKey = (await bob.getAddressInfo(bobKeyAddr)).pubkey;

    // Extract private key expressions for multisig descriptor import
    const alicePrivKeyExpr = await getPrivKeyExpr(alice, aliceKeyAddr);
    const bobPrivKeyExpr = await getPrivKeyExpr(bob, bobKeyAddr);

    // Create 2-of-2 P2WSH multisig address
    const multisigResult = await client.command('createmultisig', 2, [alicePubKey, bobPubKey], 'bech32');
    const multisigAddress = multisigResult.address;
    const witnessScript = multisigResult.redeemScript;

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

    await client.command('generatetoaddress', 6, minerAddress);

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

    // Create spending PSBT and update with the raw-pubkey multisig descriptor
    // (use pubkeys, not xpub/xprv, to avoid hardened derivation issues)
    let spendingPsbt = await client.command('createpsbt', spendingInputs, spendingOutputs);
    const pubDescRaw = `wsh(multi(2,${alicePubKey},${bobPubKey}))`;
    const pubDescInfo = await client.command('getdescriptorinfo', pubDescRaw);
    spendingPsbt = await client.command('utxoupdatepsbt', spendingPsbt, [pubDescInfo.descriptor]);

    // Both wallets sign (they now have private keys for the multisig)
    const aliceSpendSigned = await alice.command('walletprocesspsbt', spendingPsbt, true, 'ALL');
    const bobSpendSigned = await bob.command('walletprocesspsbt', spendingPsbt, true, 'ALL');

    const combinedSpending = await client.command('combinepsbt', [aliceSpendSigned.psbt, bobSpendSigned.psbt]);
    const finalizedSpending = await client.command('finalizepsbt', combinedSpending);
    if (!finalizedSpending.complete) throw new Error('Spending PSBT could not be finalized');

    const spendingTxId = await client.sendRawTransaction(finalizedSpending.hex);

    await client.command('generatetoaddress', 6, minerAddress);

    fs.writeFileSync(path.join(__dirname, '..', 'out.txt'), `${fundingTxId}\n${spendingTxId}\n`);
    console.log('Everything went perfect and results are written down to out.txt');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});

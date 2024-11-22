import { stringToPath } from '@cosmjs/crypto'
import fs from 'fs'
import { Wallet, utils } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// Load environment variables from .env
var mnemonic = process.env.mnemonic;
var chainId = process.env.chainId;
var rpcEndpoint = process.env.rpcEndpoint;
var bech32Prefix = process.env.bech32Prefix;
var txDenom = process.env.txDenom;
var txAmount = process.env.txAmount;
var txFeeAmount = process.env.txFeeAmount;
var txGasLimit = process.env.txGasLimit;
var limitAddress = process.env.limitAddress;
var limitIp = process.env.limitIp;

const HOME = ".faucet";
const mnemonic_path = `${HOME}/mnemonic.txt`;

if (!fs.existsSync(mnemonic_path)) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(mnemonic_path, Wallet.fromMnemonic(
        utils.entropyToMnemonic(utils.randomBytes(32))
    ).mnemonic.phrase);
}

if (!process.env.mnemonic) {
    mnemonic = fs.readFileSync(mnemonic_path, 'utf8');
}

export default {
    port: 8088, // http port 
    db: {
        path: `${HOME}/history.db` // save request states 
    },
    project: {
        name: "Get Testnet POKT",
        longName: 'Pocket Testnet',
        logo: "https://assets-global.website-files.com/651fe0a9a906d151784935f8/65834aed8fd922fc4829817f_Logo-wordm-white.svg",
        deployer: `<a href="https://faucet.pokt.network">Testnet POKT</a>`
    },
    blockchains: [
        {
            name: chainId,
            endpoint: {
                rpc_endpoint: rpcEndpoint,
                // Ensure CORS is enabled in the RPC section of config.toml.
                // Example: cors_allowed_origins = ["*"]
            },
            sender: {
                mnemonic,
                option: {
                    hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
                    prefix: bech32Prefix // human readable address prefix
                }
            },
            tx: {
                amount: [
                    {
                        denom: txDenom,
                        amount: txAmount
                    },
                ],
                fee: txFeeAmount ? [
                    {
                        amount: txFeeAmount,
                        denom: txDenom,
                    },
                ] : [],
                gas: txGasLimit,
            },
            limit: {
                address: limitAddress, // Number of requests per wallet address in 24h
                ip: limitIp, // Number of requests per IP in 24h
            }
        },
    ]
}

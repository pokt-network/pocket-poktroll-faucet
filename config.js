
import { stringToPath } from '@cosmjs/crypto'
import fs from 'fs'
// import { ethers } from 'ethers'
import { Wallet, utils } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// Load environment variables from process.env with defaults if not set
var mnemonic = process.env.mnemonic;
var rpcEndpoint = process.env.rpcEndpoint || "https://testnet-validated-validator-rpc.poktroll.com";
var txAmount = process.env.txAmount || 10000000;
var txFeeAmount = process.env.txFeeAmount || 10000;
var txGasLimit = process.env.txGasLimit || 100000;

const HOME = ".faucet";
const mnemonic_path= `${HOME}/mnemonic.txt`
if (!fs.existsSync(mnemonic_path)) {
    fs.mkdirSync(HOME, { recursive: true })
    fs.writeFileSync(mnemonic_path, Wallet.fromMnemonic(
        utils.entropyToMnemonic(utils.randomBytes(32))
      ).mnemonic.phrase)
}
if(!process.env.mnemonic)
    mnemonic = fs.readFileSync(mnemonic_path, 'utf8')

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
            name: "poktroll",
            endpoint: {
                // make sure that CORS is enabled in rpc section in config.toml
                // cors_allowed_origins = ["*"]
                rpc_endpoint: rpcEndpoint,
            },
            sender: {
                mnemonic,
                option: {
                    hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
                    prefix: "pokt" // human readable address prefix
                }
            },
            tx: {
                amount: [
                    {
                        denom: "upokt",
                        amount: txAmount
                    },
                ],
                fee: {
                    amount: [],
                    gas: txGasLimit
                },
            },
            limit: {
                // how many times each wallet address is allowed in a window(24h)
                address: 2,
                // how many times each ip is allowed in a window(24h),
                // if you use proxy, double check if the req.ip is return client's ip.
                ip: 10
            }
        },
    ]
}
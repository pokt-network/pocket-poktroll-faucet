import { Bip39, Random, stringToPath } from '@cosmjs/crypto'
import fs from 'fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv';
dotenv.config();

const HOME = ".faucet";
const mnemonic_path = `${HOME}/mnemonic.txt`;

if (!fs.existsSync(mnemonic_path)) {
    fs.mkdirSync(HOME, { recursive: true });
    // 32 bytes of entropy, same as before, so this still yields 24 words.
    fs.writeFileSync(mnemonic_path, Bip39.encode(Random.getBytes(32)).toString());
}

// Chain definitions carry no secrets, so they live in a file rather than in the
// environment. Point chainsFile elsewhere to mount a different set.
const chainsFile = process.env.chainsFile
    ? process.env.chainsFile
    : fileURLToPath(new URL('chains.json', import.meta.url));

const defined = JSON.parse(fs.readFileSync(chainsFile, 'utf8'));

if (!Array.isArray(defined) || defined.length === 0) {
    throw new Error(`No chains defined in ${chainsFile}`);
}

const duplicate = defined.map(c => c.id).find((id, i, all) => all.indexOf(id) !== i);
if (duplicate) {
    // Ids are the route key and the rate-limit namespace, so a collision would
    // silently merge two deployments' quotas.
    throw new Error(`Duplicate chain id "${duplicate}" in ${chainsFile}`);
}

// Each chain may name its own mnemonic variable, so mainnet and beta can hold
// separate keys. Falls back to a shared `mnemonic`, then to the generated one.
const generated = fs.readFileSync(mnemonic_path, 'utf8').trim();
function mnemonicFor(chain) {
    return (chain.mnemonicEnv && process.env[chain.mnemonicEnv])
        || process.env.mnemonic
        || generated;
}

export default {
    port: Number(process.env.port ?? 8088),
    db: {
        path: `${HOME}/history.db` // save request states
    },
    project: {
        name: "Get Pocket Tokens",
        longName: 'Pocket Faucet',
        logo: "https://assets-global.website-files.com/651fe0a9a906d151784935f8/65834aed8fd922fc4829817f_Logo-wordm-white.svg",
        deployer: `<a href="https://faucet.pocket.network">Pocket Faucet</a>`
    },
    blockchains: defined.map(c => ({
        // `name` is the route key and the rate-limit namespace. It is the
        // deployment id, not the chain id, because beta serves two tokens off
        // one chain and each needs its own quota.
        name: c.id,
        label: c.label,
        chainId: c.chainId,
        chainType: c.chainType,
        tokenName: c.tokenName,
        tokenDecimals: Number(c.tokenDecimals ?? 6),
        initDenom: c.initDenom || '',
        timeout: c.txTimeout,
        endpoint: {
            rpc_endpoint: c.rpcEndpoint,
            api_endpoint: c.apiEndpoint
            // Ensure CORS is enabled in the RPC section of config.toml.
            // Example: cors_allowed_origins = ["*"]
        },
        sender: {
            mnemonic: mnemonicFor(c),
            option: {
                hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
                prefix: c.bech32Prefix // human readable address prefix
            }
        },
        tx: {
            amount: [
                {
                    denom: c.txDenom,
                    amount: c.txAmount
                },
            ],
            fee: c.txFeeAmount ? [
                {
                    amount: c.txFeeAmount,
                    denom: c.txFeeDenom,
                },
            ] : [],
            gas: c.txGasLimit,
        },
        limit: {
            address: c.limitAddress, // Number of requests per wallet address in limitHours
            ip: c.limitIp, // Number of requests per IP in limitHours
            hours: c.limitHours, // Number of hours
        }
    }))
}

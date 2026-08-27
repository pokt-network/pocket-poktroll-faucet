import { stringToPath } from '@cosmjs/crypto'
import fs from 'fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv';
dotenv.config();

const HOME = ".faucet";

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
// separate keys, falling back to a shared `mnemonic`.
//
// A missing key is fatal. This used to generate a random mnemonic and write it
// to disk, which meant a misconfigured deployment started successfully with an
// empty wallet and failed only once someone asked it for tokens. A process that
// refuses to start is far easier to diagnose than one that looks healthy and
// cannot pay.
function mnemonicFor(chain) {
    const mnemonic = (chain.mnemonicEnv && process.env[chain.mnemonicEnv]) || process.env.mnemonic;
    if (!mnemonic || !mnemonic.trim()) {
        const named = chain.mnemonicEnv ? `${chain.mnemonicEnv} or ` : '';
        throw new Error(
            `No mnemonic for chain "${chain.id}". Set ${named}mnemonic in the environment.`
        );
    }
    return mnemonic.trim();
}

export default {
    port: Number(process.env.port ?? 8088),
    // Separate listener so /metrics is not routable through the public ingress.
    metricsPort: Number(process.env.metricsPort ?? 9464),
    db: {
        path: `${HOME}/history.db` // save request states
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

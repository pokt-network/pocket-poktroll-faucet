import express from 'express';
import { fileURLToPath } from 'node:url';

import { isValidAddress } from "./address.js";
import { createSerializer } from "./serialize.js";
import { classifyFailure } from "./failures.js";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

import conf from './config.js'
import { FrequencyChecker } from './checker.js';
import {
  registry, sendsTotal, rejectionsTotal, broadcastSeconds,
  walletBalance, walletBalanceSeconds, rpcHealthy, dbOpen,
} from './metrics.js';

// load config
console.log("loaded config: ", conf)

const app = express()

app.set("view engine", "ejs");

// Resolve views and static assets against this file, not process.cwd(), so the
// app can be started from any working directory.
app.set("views", fileURLToPath(new URL('views', import.meta.url)));

// Number of reverse proxies in front of this app. req.ip is only trustworthy
// once this matches reality; client-supplied forwarding headers are not.
app.set('trust proxy', Number(process.env.trustProxy ?? 1));

// Serve static files from the public directory
app.use(express.static(fileURLToPath(new URL('public', import.meta.url))));

const checker = new FrequencyChecker(conf)

// Liveness: the process is up and the event loop is turning. Deliberately does
// no crypto and touches no chain, so a chain outage never restarts the pod.
app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
})

// Readiness: distinct from liveness on purpose. The rate-limit database takes
// an exclusive lock, so a pod that lost it must stop receiving traffic rather
// than serve requests it cannot meter.
app.get('/readyz', (req, res) => {
  const open = checker.isOpen();
  dbOpen.set(open ? 1 : 0);
  if (!open) {
    return res.status(503).type('text/plain').send('rate-limit database is not open');
  }
  res.type('text/plain').send('ready');
})

app.get('/', (req, res) => {
  res.render('index', conf);
})

app.get('/config.json', async (req, res) => {
  const sample = {}
  for (const chainConf of conf.blockchains) {
    // Cached, so this no longer runs BIP39 key stretching on every request.
    const { address } = await walletFor(chainConf)
    sample[chainConf.name] = address
  }

  // Built fresh per request. This used to mutate conf.project in place, which
  // accumulated derived state on the shared config object.
  const project = {}
  project.sample = sample
  project.blockchains = conf.blockchains.map(x => x.name)
  // Everything the page renders is per chain, because one deployment now
  // serves several. The client picks one and reads its entry.
  project.chains = conf.blockchains.map(x => ({
    id: x.name,
    label: x.label,
    chainId: x.chainId,
    chainType: x.chainType,
    tokenName: x.tokenName,
    // Scale the raw on-chain amount to the unit users see. This used to divide
    // by 1e6 unconditionally, which only made sense for upokt.
    txAmount: Number(x.tx?.amount[0]?.amount ?? 0) / 10 ** x.tokenDecimals,
    limitAddress: x.limit.address,
    limitHours: x.limit.hours,
    // Set when the chain serves each address only once, regardless of limits.
    oneTimeOnly: Boolean(x.initDenom),
    // Derived from chainType rather than a hardcoded chain id, so the pill does
    // not depend on what the network happens to call itself.
    isBeta: String(x.chainType).toUpperCase() === 'BETA',
  }))
  res.send(project);
})

app.get('/send/:chain/:address', async (req, res) => {
  const {chain, address} = req.params;
  const ip = req.ip;
  // Logged so the trust proxy setting can be verified against the real ingress:
  // xff should contain exactly `trust proxy` entries, and ip should be the
  // client's real address. See the trustProxy note in the README.
  console.log('request tokens to', address,
    '| ip=' + ip,
    '| xff=' + JSON.stringify(req.headers['x-forwarded-for'] ?? null),
    '| trustProxy=' + app.get('trust proxy'));

  if (!chain || !address) {
    return res.send({ result: 'chain and address are required' });
  }

  try {
    const chainConf = conf.blockchains.find(x => x.name === chain);
    if (!chainConf) {
      return res.send({ result: `Address [${address}] is not supported.` });
    }

    // Decode the address rather than just checking its prefix. A prefix-only
    // check lets a typo through to be signed and broadcast, where the chain
    // rejects it with an invalid-address error and the fee is spent anyway.
    if (!isValidAddress(address, chainConf.sender.option.prefix)) {
      rejectionsTotal.inc({ chain, rule: 'invalid_address' });
      return res.send({ result: `Address [${address}] is not a valid ${chainConf.sender.option.prefix} address.` });
    }

    const isHealthy = await checkRpcHealth(chainConf.endpoint.rpc_endpoint);

    if(!isHealthy){
      rejectionsTotal.inc({ chain, rule: 'rpc_unhealthy' });
      return res.status(503).send({result: "RPC endpoint for pocket appears to be unreachable"})
    }

    // Primary gate. Both quotas are consumed up front and atomically, so a
    // burst of concurrent requests cannot slip past between check and record.
    const addressOk = await checker.checkAddress(address, chain);
    if (!addressOk) {
      rejectionsTotal.inc({ chain, rule: 'address_quota' });
      return res.send({ result: { code: 1, message: "This address has reached its request limit. Please try again later." } });
    }

    const ipOk = await checker.checkIp(ip, chain);
    if (!ipOk) {
      rejectionsTotal.inc({ chain, rule: 'ip_quota' });
      await checker.refund(checker.addressKey(address, chain));
      return res.send({ result: { code: 1, message: "Too many requests from this network. Please try again later." } });
    }

    // Optional secondary filter, enabled by setting initDenom: serve each
    // address only once, by skipping any that already holds that denom. With
    // initDenom empty the quota above is the only gate, which is what a
    // repeat-use faucet wants.
    //
    // Fails open, which is only acceptable because the quota has already
    // committed. Note this is the REST API host, not the CometBFT RPC host.
    let alreadyFunded = false;
    if (chainConf.initDenom) {
      try {
        const balanceUrl = `${chainConf.endpoint.api_endpoint}/cosmos/bank/v1beta1/balances/${address}`;
        console.log('Checking balances at:', balanceUrl);

        const balanceResponse = await fetch(balanceUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000)
        });

        if (!balanceResponse.ok) {
          throw new Error(`balance check returned status ${balanceResponse.status}`);
        }

        const contentType = balanceResponse.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error('balance endpoint returned a non-JSON response');
        }

        const results = await balanceResponse.json();
        console.log("Balances for ", address, results);
        alreadyFunded = results.balances?.some(
          r => r.denom === chainConf.initDenom && parseInt(r.amount) > 0
        ) ?? false;
      } catch (balanceError) {
        console.error('Balance check failed, falling back to quota only:', balanceError.message);
      }
    }

    // The quota stays consumed here on purpose: refunding it would let a
    // funded address hammer the balance endpoint for free.
    if (alreadyFunded) {
      rejectionsTotal.inc({ chain, rule: 'already_initialized' });
      return res.send({
        result: {
          code: 1,
          message: `This account has already been initialized with ${chainConf.tokenName}. Additional requests are not allowed.`
        }
      });
    }

    console.log('send tokens to ', address);

    try {
      const ret = await sendTx(address, chain);
      console.log("Transaction result: ", ret);
      res.send({ result: ret });
    } catch (err) {
      console.error('Transaction error:', err);
      // The send never landed, so hand both quotas back.
      await checker.refund(checker.addressKey(address, chain));
      await checker.refund(checker.ipKey(ip, chain));
      res.send({ result: { code: 1, message: `Transaction failed: ${err.message}` } });
    }
  } catch (err) {
    console.error('General error:', err);
    res.send({ result: { code: 1, message: 'Failed, Please contact admin.' } });
  }
})
// Add a function to check RPC endpoint health
async function checkRpcHealth(endpoint) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'health',
        params: []
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.warn(`RPC endpoint returned status ${response.status}`);
      return false;
    }
    
    await response.json();
    return true;
  } catch (error) {
    console.error(`RPC health check failed: ${error.message}`);
    return false;
  }
}

// Add RPC health check to app startup
// How often the sender balances are refreshed. Polled on a timer rather than on
// scrape so a slow or unreachable REST host cannot stall Prometheus.
const BALANCE_REFRESH_MS = Number(process.env.balanceRefreshMs ?? 60000);

async function refreshBalances() {
  for (const chainConf of conf.blockchains) {
    try {
      const { address } = await walletFor(chainConf);
      const url = `${chainConf.endpoint.api_endpoint}/cosmos/bank/v1beta1/balances/${address}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const { balances = [] } = await response.json();

      // Report the token being handed out and the gas denom, even at zero, so
      // an empty faucet is a visible 0 rather than an absent series.
      const denoms = new Set([
        chainConf.tx.amount[0].denom,
        chainConf.tx.fee?.[0]?.denom,
      ].filter(Boolean));
      for (const denom of denoms) {
        const found = balances.find(b => b.denom === denom);
        walletBalance.set({ chain: chainConf.name, denom }, Number(found?.amount ?? 0));
      }
      walletBalanceSeconds.set({ chain: chainConf.name }, Date.now() / 1000);
    } catch (err) {
      // Leave the previous value in place; the staleness gauge shows the gap.
      console.warn(`Balance refresh failed for ${chainConf.name}:`, err.message);
    }
  }
}

async function refreshRpcHealth() {
  for (const chainConf of conf.blockchains) {
    const healthy = await checkRpcHealth(chainConf.endpoint.rpc_endpoint);
    rpcHealthy.set({ chain: chainConf.name }, healthy ? 1 : 0);
    if (!healthy) {
      console.warn(`RPC endpoint for ${chainConf.name} appears to be unreachable.`);
    }
  }
}

app.listen(conf.port, async () => {
  console.log(`Faucet app listening on port ${conf.port}`);

  for (const chainConf of conf.blockchains) {
    const { address } = await walletFor(chainConf);
    console.log(`  ${chainConf.name}: sender ${address} on ${chainConf.chainId}`);
  }

  await refreshRpcHealth();
  await refreshBalances();

  // unref so a pending timer never holds the process open during shutdown.
  setInterval(() => { refreshBalances().catch(() => {}) }, BALANCE_REFRESH_MS).unref();
  setInterval(() => { refreshRpcHealth().catch(() => {}) }, BALANCE_REFRESH_MS).unref();
});

// Metrics live on their own listener so /metrics is never routable through the
// public ingress. Scrape this port directly from the ServiceMonitor.
const metricsApp = express();
metricsApp.get('/metrics', async (req, res) => {
  try {
    dbOpen.set(checker.isOpen() ? 1 : 0);
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});
metricsApp.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
metricsApp.listen(conf.metricsPort, () => {
  console.log(`Metrics listening on port ${conf.metricsPort}`);
});

// Deriving a wallet runs BIP39's key stretching, which is slow, and the result
// never changes. Cached per chain.
const walletCache = new Map()
async function walletFor(chainConf) {
  if (!walletCache.has(chainConf.name)) {
    walletCache.set(chainConf.name, (async () => {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option)
      const [account] = await wallet.getAccounts()
      return { wallet, address: account.address }
    })())
  }
  return walletCache.get(chainConf.name)
}

// Broadcasts from one account must not overlap. cosmjs reads the account's
// sequence number immediately before signing, so two concurrent sends read the
// same value and the second is rejected as a sequence mismatch. Pinning the
// deployment to one replica does not help: the race is between requests inside
// a single process.
//
// Keyed by account and chain rather than by configuration entry, because two
// entries may share a mnemonic and therefore the same on-chain account.
const serializeSend = createSerializer()

async function sendCosmosTx(recipient, chain) {
  const chainConf = conf.blockchains.find(x => x.name === chain) 
  if(chainConf) {
    const { wallet, address: sender } = await walletFor(chainConf);
    const rpcEndpoint = chainConf.endpoint.rpc_endpoint;

    try {
      console.log(`Attempting to connect to RPC endpoint: ${rpcEndpoint}`);
      
      // Format the amount properly
      const amount = [{
        denom: chainConf.tx.amount[0].denom,
        amount: chainConf.tx.amount[0].amount.toString() // Ensure amount is a string
      }];

      // Format the fee properly
      const fee = {
        amount: chainConf.tx.fee || [{
          amount: "0",
          denom: chainConf.tx.amount[0].denom
        }],
        gas: chainConf.tx.gas?.toString() || "200000"
      };

      // Create client with proper configuration and increased timeout
      const client = await SigningStargateClient.connectWithSigner(
        rpcEndpoint, 
        wallet,
        { 
          broadcastTimeoutMs: chainConf.timeout || 500000, // 120 seconds broadcast timeout
          broadcastPollIntervalMs: 4000, // Poll every 4 seconds instead of default 3s
        }
      );

      console.log("Successfully connected to RPC endpoint");

      // Send tokens with proper error handling
      const result = await client.sendTokens(
        sender,
        recipient,
        amount,
        fee,
        "Faucet token transfer" // Add memo for better traceability
      );

      console.log("Transaction sent successfully:", result.transactionHash);

      // Return a cleaned up response
      return {
        code: 0,
        height: result.height,
        txhash: result.transactionHash,
      };

    } catch (error) {
      console.error('Transaction failed:', error);
      
      // More detailed error handling
      if (error.message && error.message.includes('timeout') && error.txId) {
        console.log(`Transaction was submitted with ID ${error.txId} but confirmation timed out.`);
        console.log(`The transaction might still be processed. Check the explorer for tx: ${error.txId}`);
        
        // Return partial success since tx was submitted
        return {
          code: 1, // Non-zero but not a complete failure
          status: "PENDING",
          message: "Transaction was submitted but confirmation timed out. It may still be processed.",
          txhash: error.txId
        };
      } else if (error.message && error.message.includes('timeout')) {
        throw new Error(`Connection to blockchain node timed out. Please try again later or contact admin if the issue persists.`);
      } else if (error.message && error.message.includes('failed')) {
        throw new Error(`Failed to connect to blockchain node. The node may be offline or unreachable.`);
      } else {
        throw new Error(`Transaction failed: ${error.message}`);
      }
    }
  }
  throw new Error(`Blockchain Config [${chain}] not found`);
}

function sendTx(recipient, chain) {
  const chainConf = conf.blockchains.find(x => x.name === chain)
  if (!chainConf) throw new Error(`Blockchain Config [${chain}] not found`)

  // One broadcast at a time per account, so signing never races on the
  // sequence number. walletFor is cached, so this resolves immediately after
  // the first call.
  return walletFor(chainConf).then(({ address: sender }) =>
    serializeSend(`${chainConf.chainId}:${sender}`, async () => {
      const stop = broadcastSeconds.startTimer({ chain })
      try {
        const result = await sendCosmosTx(recipient, chain)
        const outcome = result?.code === 0 ? 'success' : 'pending'
        stop({ outcome })
        sendsTotal.inc({ chain, outcome, reason: '' })
        return result
      } catch (err) {
        stop({ outcome: 'failure' })
        sendsTotal.inc({ chain, outcome: 'failure', reason: classifyFailure(err) })
        throw err
      }
    })
  )
}



import express from 'express';
import { fileURLToPath } from 'node:url';

import { isValidAddress } from "./address.js";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

import conf from './config.js'
import { FrequencyChecker } from './checker.js';

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

app.get('/', (req, res) => {
  res.render('index', conf);
})

app.get('/config.json', async (req, res) => {
  const sample = {}
  for(let i =0; i < conf.blockchains.length; i++) {
    const chainConf = conf.blockchains[i]
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
    const [firstAccount] = await wallet.getAccounts();
    sample[chainConf.name] = firstAccount.address
    console.log('address:', chainConf.name, firstAccount.address)
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

app.get('/balance/:chain', async (req, res) => {
  const { chain }= req.params

  let balance = {}

  try{
    const chainConf = conf.blockchains.find(x => x.name === chain)
    if(chainConf) {
      const rpcEndpoint = chainConf.endpoint.rpc_endpoint;
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
      const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
      const [firstAccount] = await wallet.getAccounts();
      await client.getBalance(firstAccount.address, chainConf.tx.amount[0].denom).then(x => {
        balance = x
      }).catch(e => console.error(e));
    }
  } catch(err) {
    console.log(err)
  }
  res.send(balance);
})
app.get('/send/:chain/:address', async (req, res) => {
  const {chain, address} = req.params;
  const ip = req.ip;
  console.log('request tokens to ', address, ip);

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
      return res.send({ result: `Address [${address}] is not a valid ${chainConf.sender.option.prefix} address.` });
    }

    const isHealthy = await checkRpcHealth(chainConf.endpoint.rpc_endpoint);

    if(!isHealthy){
      return res.status(503).send({result: "RPC endpoint for pocket appears to be unreachable"})
    }

    // Primary gate. Both quotas are consumed up front and atomically, so a
    // burst of concurrent requests cannot slip past between check and record.
    const addressOk = await checker.checkAddress(address, chain);
    if (!addressOk) {
      return res.send({ result: { code: 1, message: "This address has reached its request limit. Please try again later." } });
    }

    const ipOk = await checker.checkIp(ip, chain);
    if (!ipOk) {
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
    
    const data = await response.json();
    return true;
  } catch (error) {
    console.error(`RPC health check failed: ${error.message}`);
    return false;
  }
}

// Add RPC health check to app startup
app.listen(conf.port, async () => {
  console.log(`Faucet app listening on port ${conf.port}`);
  
  // Check RPC endpoints health on startup
  for (const chainConf of conf.blockchains) {
    const isHealthy = await checkRpcHealth(chainConf.endpoint.rpc_endpoint);
    console.log(`RPC endpoint for ${chainConf.name}: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`);
    
    if (!isHealthy) {
      console.warn(`Warning: RPC endpoint for ${chainConf.name} appears to be unreachable.`);
      console.warn(`Please check your network connection or try an alternative endpoint.`);
    }
  }
});

async function sendCosmosTx(recipient, chain) {
  const chainConf = conf.blockchains.find(x => x.name === chain) 
  if(chainConf) {
    try {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(
        chainConf.sender.mnemonic, 
        chainConf.sender.option
      );
      const [firstAccount] = await wallet.getAccounts();
      const rpcEndpoint = chainConf.endpoint.rpc_endpoint;
      
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
        firstAccount.address,
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
  return sendCosmosTx(recipient, chain)
}

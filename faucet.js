import express from 'express';
import * as path from 'path'

import { Wallet } from '@ethersproject/wallet'
import { pathToString } from '@cosmjs/crypto';

import { ethers } from 'ethers'
import { bech32 } from 'bech32';

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

import conf from './config.js'
import { FrequencyChecker } from './checker.js';

// Add node-fetch for RPC health checks
import fetch from 'node-fetch';

// load config
console.log("loaded config: ", conf)

const app = express()

app.set("view engine", "ejs");

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

    const wallet2 = Wallet.fromMnemonic(chainConf.sender.mnemonic, pathToString(chainConf.sender.option.hdPaths[0]));
    console.log('address:', firstAccount.address, wallet2.address)
  }

  const project = conf.project
  project.sample = sample
  project.blockchains = conf.blockchains.map(x => x.name)
  project.txAmount = conf.blockchains[0].tx?.amount[0]?.amount / 1000000
  project.isBeta = process.env.chainId == "pocket-beta"
  project.chainType = process.env.chainType || 'TESTNET'
  res.send(project);
})

app.get('/balance/:chain', async (req, res) => {
  const { chain }= req.params

  let balance = {}

  try{
    const chainConf = conf.blockchains.find(x => x.name === chain)
    if(chainConf) {
      if(chainConf.type === 'Ethermint') {
        const ethProvider = new ethers.providers.JsonRpcProvider(chainConf.endpoint.evm_endpoint);
        const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic, pathToString(chainConf.sender.option.hdPaths[0])).connect(ethProvider);
        await wallet.getBalance().then(ethBlance => {
          balance = {
            denom:chainConf.tx.amount.denom,
            amount:ethBlance.toString()
          }
        }).catch(e => console.error(e))

      }else{
        const rpcEndpoint = chainConf.endpoint.rpc_endpoint;
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
        const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
        const [firstAccount] = await wallet.getAccounts();
        await client.getBalance(firstAccount.address, chainConf.tx.amount[0].denom).then(x => {
          balance = x
        }).catch(e => console.error(e));
      }
    }
  } catch(err) {
    console.log(err)
  }
  res.send(balance);
})

app.get('/send/:chain/:address', async (req, res) => {
  const {chain, address} = req.params;
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['X-Forwarded-For'] || req.ip;
  console.log('request tokens to ', address, ip);

  if (!chain || !address) {
    return res.send({ result: 'chain and address are required' });
  }

  try {
    const chainConf = conf.blockchains.find(x => x.name === chain);
    if (!chainConf || !(address.startsWith(chainConf.sender.option.prefix) || address.startsWith('0x'))) {
      return res.send({ result: `Address [${address}] is not supported.` });
    }

    const addressCheck = checker.checkAddress(address, chain);
    // const ipCheck = checker.checkIp(`${chain}${ip}`, chain);
    
    const balances = await fetch(`${chainConf.endpoint.rpc_endpoint}/cosmos/bank/v1beta1/balances/${address}`)
    const results = await balances.json()

    console.log("Balances for ", address, results)

    const addressResult = results.balances.filter(r => r.denom == 'mact' && r.amount == '1').length == 0;
    // const [addressResult] = await Promise.all([addressCheck, ipCheck]);

    console.log('Checking address:', addressResult);
    // console.log('Checking IP:', ipResult);

    if (addressResult) {
      await checker.update(`${chain}${ip}`); // get ::1 on localhost
      console.log('send tokens to ', address);
      
      try {
        const ret = await sendTx(address, chain);
        console.log("xxl ret : ",ret);
        checker.update(address.toString());
        res.send({ result: ret });
      } catch (err) {
        res.send({ result: `err: ${err}` });
      }
    } else {
      res.send({ result: "You account is already initialized with 1 MACT" });
    }
  } catch (err) {
    console.error(err);
    res.send({ result: 'Failed, Please contact admin.' });
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

async function sendEvmosTx(recipient, chain) {

  try{
    const chainConf = conf.blockchains.find(x => x.name === chain) 
    const ethProvider = new ethers.providers.JsonRpcProvider(chainConf.endpoint.evm_endpoint);

    const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic).connect(ethProvider);

    let evmAddress =  recipient;
    if(recipient && !recipient.startsWith('0x')) {
      let decode = bech32.decode(recipient);
      let array = bech32.fromWords(decode.words);
      evmAddress =  "0x" + toHexString(array);
    }

    let result = await wallet.sendTransaction(
        { 
          from:wallet.address,
          to:evmAddress,
          value:chainConf.tx.amount.amount
        }
      );
   
    let repTx = {
      "code":0,
      "nonce":result["nonce"],
      "value":result["value"].toString(),
      "hash":result["hash"]
    };

    console.log("xxl result : ",repTx);
    return repTx;
  }catch(e){
    console.log("xxl e ",e);
    return e;
  }

}

function toHexString(bytes) {
  return bytes.reduce(
      (str, byte) => str + byte.toString(16).padStart(2, '0'), 
      '');
}

async function sendTx(recipient, chain) {
  const chainConf = conf.blockchains.find(x => x.name === chain) 
  if(chainConf.type === 'Ethermint') {
    return sendEvmosTx(recipient, chain)
  }
  return sendCosmosTx(recipient, chain)
}

// write a function to send evmos transaction
async function sendEvmosTx2(recipient, chain) {

  // use evmosjs to send transaction
  const chainConf = conf.blockchains.find(x => x.name === chain) 
  // create a wallet instance
  const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic).connect(chainConf.endpoint.evm_endpoint);
}

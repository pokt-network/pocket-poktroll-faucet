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
    const ipCheck = checker.checkIp(`${chain}${ip}`, chain);

    const [addressResult, ipResult] = await Promise.all([addressCheck, ipCheck]);

    console.log('Checking address:', addressResult);
    console.log('Checking IP:', ipResult);

    if (addressResult && ipResult) {
      await checker.update(`${chain}${ip}`); // get ::1 on localhost
      console.log('send tokens to ', address);
      
      try {
        const ret = await sendTx(address, chain);
        await checker.update(address.toString());
        res.send({ result: ret });
      } catch (err) {
        res.send({ result: `err: ${err}` });
      }
    } else {
      res.send({ result: "You requested too often" });
    }
  } catch (err) {
    console.error(err);
    res.send({ result: 'Failed, Please contact admin.' });
  }
})

app.listen(conf.port, () => {
  console.log(`Faucet app listening on port ${conf.port}`)
})
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

      // Create client with proper configuration
      const client = await SigningStargateClient.connectWithSigner(
        rpcEndpoint, 
        wallet
      );

      // Send tokens with proper error handling
      const result = await client.sendTokens(
        firstAccount.address,
        recipient,
        amount,
        fee
      );

      console.log("xxl result : ",result);

      // Return a cleaned up response
      return {
        code: 0,
        height: result.height,
        txhash: result.transactionHash,
        gasUsed: result.gasUsed,
        gasWanted: result.gasWanted
      };

    } catch (error) {
      console.error('Transaction failed:', error);
      throw new Error(`Transaction failed: ${error.message}`);
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

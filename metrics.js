import client from 'prom-client';

// Served on a separate port so /metrics is never routable through the public
// ingress. See metricsPort in the configuration.
export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry, prefix: 'faucet_' });

export const sendsTotal = new client.Counter({
    name: 'faucet_sends_total',
    help: 'Send requests that reached the broadcast step, by outcome.',
    labelNames: ['chain', 'outcome', 'reason'],
    registers: [registry],
});

export const rejectionsTotal = new client.Counter({
    name: 'faucet_rejections_total',
    help: 'Requests refused before broadcast, by the rule that refused them.',
    labelNames: ['chain', 'rule'],
    registers: [registry],
});

export const broadcastSeconds = new client.Histogram({
    name: 'faucet_broadcast_duration_seconds',
    help: 'Time from starting a send to the node accepting or rejecting it.',
    labelNames: ['chain', 'outcome'],
    // A broadcast waits for inclusion, so the useful range is seconds to a minute.
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [registry],
});

// The alert that matters: an empty faucet fails every request while looking
// healthy in every other respect.
export const walletBalance = new client.Gauge({
    name: 'faucet_wallet_balance',
    help: 'Faucet sender balance, in the smallest denomination.',
    labelNames: ['chain', 'denom'],
    registers: [registry],
});

// Gas is the binding constraint long before the distributed token runs out,
// so it is tracked separately from the token being handed out.
export const walletBalanceSeconds = new client.Gauge({
    name: 'faucet_wallet_balance_updated_seconds',
    help: 'Unix time of the last successful balance refresh, by chain.',
    labelNames: ['chain'],
    registers: [registry],
});

export const rpcHealthy = new client.Gauge({
    name: 'faucet_rpc_healthy',
    help: 'Whether the last RPC health check for a chain succeeded.',
    labelNames: ['chain'],
    registers: [registry],
});

export const dbOpen = new client.Gauge({
    name: 'faucet_ratelimit_db_open',
    help: 'Whether the rate-limit database is open and usable.',
    registers: [registry],
});

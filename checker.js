import { Level } from "level";

const DEFAULT_LIMIT_HOURS = 24

export class FrequencyChecker {
    constructor(conf) {
        this.conf = conf
        this.db = new Level(conf.db.path, { valueEncoding: 'json' })
        // Serializes every read-modify-write. Without this, concurrent requests
        // all read the same history before any of them writes, and the limit
        // does not hold.
        this.queue = Promise.resolve()
    }

    windowMs(chain) {
        const chainConf = this.conf.blockchains.find(x => x.name === chain)
        const hours = Number(chainConf?.limit?.hours)
        return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LIMIT_HOURS) * 3600 * 1000
    }

    async read(key) {
        try {
            const history = await this.db.get(key)
            return Array.isArray(history) ? history : []
        } catch (err) {
            if (err.code === 'LEVEL_NOT_FOUND') return []
            throw err
        }
    }

    // Runs fn as the sole owner of the db, so no other consume/refund
    // interleaves between its read and its write.
    serialize(fn) {
        const result = this.queue.then(fn, fn)
        this.queue = result.then(() => {}, () => {})
        return result
    }

    // Atomically drops expired hits and records a new one, but only if the key
    // is under its limit. Returns true when the quota was consumed.
    consume(key, limit, windowMs) {
        return this.serialize(async () => {
            const now = Date.now()
            const recent = (await this.read(key)).filter(t => now - t < windowMs)

            if (recent.length >= Number(limit)) {
                await this.db.put(key, recent) // prune only
                return false
            }

            recent.push(now)
            await this.db.put(key, recent)
            return true
        })
    }

    // Gives back the most recent hit. Only for undoing a consume whose
    // transaction then failed.
    refund(key) {
        return this.serialize(async () => {
            const history = await this.read(key)
            if (history.length === 0) return
            history.pop()
            await this.db.put(key, history)
        })
    }

    async checkIp(ip, chain) {
        const chainConf = this.conf.blockchains.find(x => x.name === chain)
        if (!chainConf) return false
        return this.consume(`ip:${chain}:${ip}`, chainConf.limit.ip, this.windowMs(chain))
    }

    async checkAddress(address, chain) {
        const chainConf = this.conf.blockchains.find(x => x.name === chain)
        if (!chainConf) return false
        return this.consume(`addr:${chain}:${address}`, chainConf.limit.address, this.windowMs(chain))
    }

    ipKey(ip, chain) { return `ip:${chain}:${ip}` }
    addressKey(address, chain) { return `addr:${chain}:${address}` }

    // Readiness signal. The database takes an exclusive lock, so a second
    // process on the same volume never reaches 'open', and a pod that cannot
    // record quota must not receive traffic.
    isOpen() {
        return this.db.status === 'open'
    }

    async close() {
        await this.queue
        await this.db.close()
    }
}

// A per-key promise chain: work submitted under the same key runs one at a
// time, in submission order, while different keys proceed independently.
//
// Used to stop concurrent broadcasts from one account overlapping. cosmjs reads
// an account's sequence number immediately before signing, so two sends that
// overlap read the same value and the second is rejected as a mismatch. Pinning
// the deployment to a single replica does not help, because the race is between
// requests inside one process.
//
// FrequencyChecker keeps its own single chain rather than using this, because
// it guards one database and also needs to await the tail on close.
export function createSerializer() {
    const chains = new Map();

    return function serialize(key, fn) {
        const previous = chains.get(key) ?? Promise.resolve();
        // Run fn whether the previous task resolved or rejected: one failed
        // send must not wedge every later send for that account.
        const result = previous.then(fn, fn);
        // Store a settled-either-way tail so the chain never accumulates
        // unhandled rejections.
        chains.set(key, result.then(() => {}, () => {}));
        return result;
    };
}

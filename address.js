import { fromBech32 } from "@cosmjs/encoding";

// Bech32 decode, checking the checksum and the human-readable prefix.
//
// A prefix-only check ("does it start with pokt") lets a typo through to be
// signed and broadcast, where the chain rejects it with an invalid-address
// error and the fee is spent anyway.
//
// The explicit limit is required: fromBech32 defaults to Infinity, which the
// decoder itself rejects as an unsafe integer.
export function isValidAddress(address, prefix) {
    try {
        const { prefix: actual, data } = fromBech32(address, 1023);
        return actual === prefix && data.length > 0;
    } catch {
        return false;
    }
}

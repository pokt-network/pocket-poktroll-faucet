// Coarse buckets, so the counter stays low cardinality while still telling us
// which failure we are looking at.
export function classifyFailure(err) {
  const m = String(err?.message ?? '').toLowerCase()
  // Order matters. An unfunded sender reports "does not exist on chain ...
  // before trying to query sequence", which contains "sequence" and would
  // otherwise be misfiled as a sequence mismatch. Match the specific cases
  // before the generic word.
  if (m.includes('does not exist on chain')) return 'sender_not_on_chain'
  if (m.includes('insufficient')) return 'insufficient_funds'
  if (m.includes('sequence')) return 'sequence_mismatch'
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout'
  if (m.includes('invalid') && m.includes('address')) return 'invalid_address'
  return 'other'
}
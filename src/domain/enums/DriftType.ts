/**
 * Explicit taxonomy of state drift between internal and provider truth.
 *
 * Each drift type has a fixed severity, recommended action, and
 * auto-repair eligibility defined in DriftTaxonomy.
 */
export enum DriftType {
  /** Internal says authorized, but provider has no record */
  INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING = 'INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING',

  /** Provider shows captured, internal hasn't recorded capture */
  PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED = 'PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED',

  /** Internal shows funds released, provider hasn't executed transfer */
  INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED = 'INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED',

  /** Provider shows dispute open, internal state is clean */
  PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN = 'PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN',

  /** Internal shows dispute open, provider says resolved */
  INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED = 'INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED',

  /** Refund state mismatch between internal and provider */
  REFUND_STATE_MISMATCH = 'REFUND_STATE_MISMATCH',

  /** Connected account status mismatch */
  CONNECTED_ACCOUNT_STATE_MISMATCH = 'CONNECTED_ACCOUNT_STATE_MISMATCH',

  /** Same provider reference linked to multiple internal records */
  DUPLICATE_PROVIDER_REFERENCE = 'DUPLICATE_PROVIDER_REFERENCE',

  /** Provider has object with no matching internal record */
  ORPHAN_PROVIDER_OBJECT = 'ORPHAN_PROVIDER_OBJECT',

  /** Internal has committed payment state with no provider match */
  ORPHAN_INTERNAL_RECORD = 'ORPHAN_INTERNAL_RECORD',
}

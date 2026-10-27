/**
 * Backward-compatible alias for the generic override approval endpoint.
 * Older clients still call the funding-specific path with `requestId`.
 */
export { POST } from '../override-approval/route'

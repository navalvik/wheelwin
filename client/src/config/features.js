/**
 * R6.5 — Client feature flags (no env / runtime config).
 *
 * Testnet no longer exposes a Page1 Mainnet switch. Network selection is
 * intentionally deferred until after the authenticated room has been created.
 */
export const SHOW_TESTNET_WARNING = true;

export const SHOW_MAINNET_SWITCH = false;

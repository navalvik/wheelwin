# WheelWin — Page1 Network Warning Fix

## Objective
Keep the Page1 warning overlay visible and make its content network-aware: Testnet must show the existing Testnet warning, while Mainnet must show a Mainnet warning.

## Confirmed root cause
The current `mainnet/production` head was commit `3b671ac722a5d5b555aa5fe0b29f2906e86ea07a`, which changed `SHOW_TESTNET_WARNING` from `true` to `false` and disabled the overlay. The earlier Mainnet-aware implementation in commit `738030b12d9d018921041551bb2c0f0811655c7b` proved the intended behavior: the overlay remains present and selects Mainnet/Testnet content at runtime.

## Fix
- Restored `SHOW_TESTNET_WARNING = true`.
- Restored network-aware overlay behavior.
- Preserved Testnet translated content.
- Added the Mainnet warning content directly in the overlay, matching the previously established Mainnet wording:
  - `⚠️ MAINNET`
  - `THIS PROJECT IS CURRENTLY RUNNING ON THE TON MAINNET.`
  - `USE TELEGRAM WALLET ONLY.`
- `SHOW_MAINNET_SWITCH` remains unchanged.
- The overlay was NOT removed.

## Validation
GitHub repository history and the current production branch files were inspected before the change. The resulting source tree is based on the current `mainnet/production` head `3b671ac...` and changes only the two files required for this issue plus this report.

No local build or Telegram runtime test was available through the GitHub connector. Production visual verification remains required after Vercel deploy.

## Commit
Commit message: `fix: restore network-aware Page1 warning`

## Deployment
The change is committed directly to GitHub on `mainnet/production`. No separate local push is required. Vercel production deployment must be verified separately.

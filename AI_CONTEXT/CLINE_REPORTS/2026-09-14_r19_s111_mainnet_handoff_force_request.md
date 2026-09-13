# WheelWin Forensic / Fix Report — R19-S111

## Scope

Continue the Telegram Android Testnet → Mainnet handoff investigation after the previous `startapp=mainnet` change was deployed to Vercel Production and the user retested:

- Telegram Android 12.10.1
- Testnet Mini App
- `MAINNET`
- Page2
- `CREATE ROOM`

The room creation still failed.

## Production evidence

Railway Mainnet logs for the Android test show:

`Stage: CREATE_ROOM_AUTHORIZATION | Decision: REJECT | Reason: No authenticated Telegram identity on socket`

The same Android user agent is visible in the Railway traffic:

`Telegram-Android/12.10.1 ... Android 16`

Therefore the Mainnet page is loading, Socket.IO connects, but the Mainnet WebApp session still has no authenticated Telegram identity.

The native Telegram profile `Launch App / Open App` control test previously succeeded and created room `TH4Q`. This continues to prove that the Main Mini App itself and server authentication are functional when Telegram performs the native profile launch.

Vercel confirms the previous handoff revision was promoted to Production, so this failure is not explained by testing an old preview deployment.

## External verification

Telegram's current documentation defines `web_app_open_tg_link` as the native event used by a Mini App to open a `t.me` deep link. The event payload includes `path_full` and an optional `force_request` flag; when `force_request` is true, the Telegram client is instructed to ignore locally cached information for the deep link. Telegram also documents Main Mini App links using `?startapp` and `?startapp=<start_parameter>` and says these are handled through the native Main Mini App launch mechanism.

This does not weaken or replace server authentication. It only changes how the Testnet Mini App asks Telegram Android to create the Mainnet Mini App launch request.

## Implemented change

### `client/src/components/HeaderBar.jsx`

The Mainnet handoff now prefers the underlying Telegram WebView bridge when it is exposed:

- event: `web_app_open_tg_link`
- `path_full`: `/wheel_win_bot?startapp=mainnet`
- `force_request`: `true`

If the internal WebView bridge is unavailable, the supported `Telegram.WebApp.openTelegramLink()` path remains as a fallback.

The plain-browser fallback remains:

`https://wheelwin-main.vercel.app`

No Testnet `initData`, `tgWebAppData`, Telegram user data, token, mnemonic, or secret is copied or forwarded.

### `client/src/components/HeaderBar.mainnetHandoff.test.js`

The focused behavioral test now verifies:

1. The native WebView bridge is preferred when available.
2. `web_app_open_tg_link` receives the exact Mainnet path and `force_request: true`.
3. `openTelegramLink()` is not called in the same path, preventing duplicate navigation requests.
4. The supported `openTelegramLink()` fallback remains available when the internal bridge is absent.
5. Browser fallback remains unchanged.
6. Hostile/missing Telegram API shapes fail safely.
7. No Testnet authentication data is forwarded or reconstructed.

## Commits

- `8f5b099fedab81425cf2ecf3daeb3dc3ff53da84` — `fix: force fresh Telegram Mainnet handoff request`
- `8e4ebbb67d9f927566270cdc6ca65dc17d6f89af` — `test: cover fresh Telegram Mainnet handoff request`

Both commits are on `mainnet/production`.

## Validation status

The source-level focused test has been updated but has not been executed in a local runtime from this environment. The client test command is `node scripts/run-tests.js`.

Production validation required:

1. Wait for Vercel to build the new revision and promote the resulting deployment to Production if it is not auto-promoted.
2. On Telegram Android, start from Testnet.
3. Tap `MAINNET`.
4. Reach Page2.
5. Tap `CREATE ROOM`.
6. Confirm that a room is created.
7. Confirm in Railway Mainnet logs that this path no longer produces `No authenticated Telegram identity on socket`.

Do not weaken server authentication or room-creation authorization.

## Current diagnosis boundary

If the `force_request` implementation still produces empty `initData` on Telegram Android, stop making speculative deep-link changes. The remaining issue should then be treated as a Telegram Android `web_app_open_tg_link` / Main Mini App launch-context problem and investigated with Telegram Android WebView diagnostics (safe metadata only; never log or expose raw `initData`).

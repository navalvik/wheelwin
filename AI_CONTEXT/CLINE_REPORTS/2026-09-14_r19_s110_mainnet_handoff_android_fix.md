# WheelWin Forensic / Fix Report — R19-S110

## Scope

Fix the Telegram Android Testnet → Mainnet handoff after the control test succeeded: Telegram Android → `@wheel_win_bot` profile → native `Launch App / Open App` → Page2 → `CREATE ROOM` successfully created room `TH4Q`.

This proves the Mainnet Mini App, Railway Mainnet backend, Telegram authentication, Socket.IO authorization, and `CREATE_ROOM` path work when Telegram opens the Main Mini App natively.

## Root-cause boundary

The failing path was specifically Testnet → MAINNET. The previous implementation used `https://t.me/wheel_win_bot?startapp` through `Telegram.WebApp.openTelegramLink()`.

On Telegram Android that path opened the Mainnet UI but the resulting WebApp session had empty Telegram `initData`. The server therefore correctly treated the Socket.IO connection as unauthenticated and rejected `CREATE_ROOM` with `No authenticated Telegram identity on socket`.

The server-side authentication gate was not weakened and must remain fail-closed.

## External verification

Telegram's official documentation confirms that Main Mini Apps support `https://t.me/<bot_username>?startapp` and `https://t.me/<bot_username>?startapp=<start_parameter>`, with Main Mini App links handled through Telegram's native Main Mini App launch mechanism (`messages.requestMainWebView`).

For this fix, a non-empty start marker is used as a targeted Android handoff change. The application does not consume the marker; it only makes the Main Mini App deep-link request explicit and distinct.

## Implemented change

### `client/src/components/HeaderBar.jsx`

Changed the Telegram-native Mainnet deep link from:

`https://t.me/wheel_win_bot?startapp`

to:

`https://t.me/wheel_win_bot?startapp=mainnet`

The handoff still uses `window.Telegram.WebApp.openTelegramLink()` when available. The plain-browser fallback remains `https://wheelwin-main.vercel.app`.

No Testnet `initData`, `tgWebAppData`, Telegram user data, token, or secret is copied or forwarded.

### `client/src/components/HeaderBar.mainnetHandoff.test.js`

Updated the focused behavioral test to require `startapp=mainnet` and preserve the existing safety contracts: Telegram-native handoff, browser fallback, fail-safe missing API behavior, and no Testnet authentication-data forwarding.

## Commits

- `0e0a38ea5ec3d5e7915b5d6b91e3c962b1dc2fb1` — `fix: make Telegram Mainnet handoff explicit`
- `497de1ae8e9a6d7c1c1516898e7f62f48285dbe2` — `test: cover explicit Mainnet launch marker`

Both commits are on `mainnet/production`.

## Validation status

The focused source-level test was updated but has not been executed in a local runtime from this environment. The client test command is `node scripts/run-tests.js`.

Production validation required: deploy the current `mainnet/production` revision to Vercel, promote it if necessary, then test Telegram Android starting from Testnet → `MAINNET` → Page2 → `CREATE ROOM`. Confirm that the room is created and Railway Mainnet no longer logs `No authenticated Telegram identity on socket` for this path.

Do not modify server authentication or room-creation authorization based on the previous failure.

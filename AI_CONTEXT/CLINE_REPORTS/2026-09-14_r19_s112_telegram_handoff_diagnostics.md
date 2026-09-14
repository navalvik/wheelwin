# R19-S112 — Telegram Testnet → Mainnet handoff diagnostics

## Status

Implemented a temporary, security-safe diagnostic pass for the unresolved Telegram Android Testnet → Mainnet handoff failure.

## Why this pass exists

The native Mainnet Mini App launch from the bot profile was already verified to create a room successfully, while the Testnet → Mainnet handoff still reaches CREATE_ROOM as an unauthenticated socket. The server therefore correctly rejects CREATE_ROOM instead of weakening authentication.

Telegram's current Mini App documentation states that `window.Telegram.WebApp.initData` is the raw signed initialization data intended for server validation. Telegram also documents that `openTelegramLink` / `web_app_open_tg_link` opens a `t.me` link while the current Mini App remains open. Main Mini App deep links are handled by Telegram's native Main Mini App flow. These facts make the exact WebView launch state at the handoff boundary the next measurement target.

## Changes

### `client/src/socket/socket.js`

Added `getTelegramInitDiagnostics()`.

It reports presence/shape only:

- Telegram runtime detected
- Telegram platform
- WebApp object present
- WebApp `initData` present
- URL `tgWebAppData` present
- Telegram WebView object present
- WebView `initParams` present
- WebView `tgWebAppData` present
- Telegram WebView proxy present
- WebView `postEvent` present
- `openTelegramLink` present
- Telegram SDK initParams entry present in sessionStorage

No raw initData, user data, hashes, URL contents, bot token, or other credentials are returned or logged by the diagnostic helper.

### `client/src/main.jsx`

If the initial Telegram wait completes with empty initData while a Telegram Mini App runtime is detected, the client now emits a safe console diagnostic and shows the same presence-only diagnostic in Telegram's native alert.

The socket still connects exactly as before. No authentication fallback was added.

### `client/src/socket/socket.telegramAuth.test.js`

Added regression coverage for populated and empty Telegram launch states and for the presence-only diagnostic contract.

## Security boundary preserved

- Server-side Telegram signature validation remains unchanged.
- CREATE_ROOM authorization remains fail-closed.
- No identity is synthesized from `startapp`.
- No Telegram user ID is accepted from client diagnostics.
- No raw `initData` is logged or displayed.
- No secret or bot token was added to client code.

## Expected next measurement

Deploy this diagnostic pass to Mainnet and perform exactly two Android launches:

1. Native bot-profile **Launch App** → Page1 → Page2 → CREATE ROOM. This is the known-good control.
2. Testnet → tap **MAINNET** → Page1 → Page2 → CREATE ROOM. This is the failing path.

The diagnostic alert should appear only when Telegram runtime is detected but raw initData remains empty after the existing 5-second wait. Compare the diagnostic fields from the failing handoff with the known-good native launch.

The result will determine whether the defect is inside the Telegram handoff/WebView launch context or inside WheelWin's client lifecycle handling. Do not weaken server authentication based on this pass.

## External Telegram documentation checked

- Telegram Mini Apps documentation: `window.Telegram.WebApp.initData` is the raw signed initialization data intended for backend validation.
- Telegram web events documentation: `web_app_open_tg_link` accepts a `path_full` t.me path and `force_request`; the current Mini App must not be closed.
- Telegram MTProto documentation: Main Mini Apps are opened through the native `messages.requestMainWebView` flow, with `start_param` passed from Main Mini App links.

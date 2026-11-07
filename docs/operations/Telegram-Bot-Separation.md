# WheelWin Telegram bot separation

## Runtime binding

Deploy the existing Testnet service with `TON_NETWORK=testnet` and keep its
current `TELEGRAM_BOT_TOKEN` value unchanged. Deploy the existing Mainnet
service with `TON_NETWORK=mainnet` and set its separate
`TELEGRAM_MAINNET_BOT_TOKEN` Railway secret to the token created for
`@WheelWinMainnetBot`. Each runtime validates Mini App `initData` only with the
token assigned to its network; there is no cross-network fallback. Never place
either token in the client build, source control, logs, or support reports.

Keep the existing Mainnet Vercel Mini App URL:
`https://wheelwin-main.vercel.app/`. The Testnet Mini App URL is the existing
Testnet deployment URL (currently identified in this repository as
`https://wheelwin-nine.vercel.app/`).

## Telegram button source and setup

The buttons come from the separate [`navalvik/wheelwin-telegram-bot`
repository](https://github.com/navalvik/wheelwin-telegram-bot/blob/main/index.js),
deployed as Railway service `wheelwin-telegram-bot` in project
`industrious-commitment`. Its `index.js` polls `getUpdates` and sends the
`/start` welcome keyboard. The current source puts YouTube on the first row,
then Testnet and Mainnet side-by-side on the second row. It also describes the
bot as offering both networks. Thus the keyboard is code in the separate bot
repository, not a BotFather keyboard setting.

Read-only Railway state on 2026-11-07: the live worker is on repo branch `main`
at deployment `985864c` (2026-11-05); no separate Mainnet bot worker is
present. Testnet backend `wheelwin` is live at `643050a` (2026-11-04), and
Mainnet backend `positive-clarity` is live at `5250be0` (2026-11-06). Both
backend deployments predate the local token-resolver commits. Railway lists
`TELEGRAM_BOT_TOKEN` on both backends and does not yet list
`TELEGRAM_MAINNET_BOT_TOKEN` on Mainnet. The code-level fix is not live until
the owner approves a push/deployment.

BotFather configures a bot's single chat menu button and Mini App URL. It does
not create a two-row custom keyboard. To keep the two Testnet launch buttons in
the requested vertical order, the existing `/start` responder (or the
provider that owns it) must send an inline keyboard with this row structure:

```json
{
  "inline_keyboard": [
    [{ "text": "YOUTUBE WHEELWIN", "url": "https://www.youtube.com/@WheelWin-Game" }],
    [{ "text": "TESTNET", "web_app": { "url": "https://wheelwin-nine.vercel.app/" } }]
  ]
}
```

Remove the `MAINNET` row from the Testnet `/start` response. The `web_app`
inline button is supported in private chats with a bot and launches the
Testnet Mini App with Telegram `initData`. Historical bot messages may retain
their old keyboard; update/replace the existing welcome message where the
provider supports it, and verify a fresh `/start` message.

For `@wheel_win_bot`, update that bot repository's `/start` keyboard to the
two rows above, remove the Mainnet button and change the bot description to
Testnet-only. Keep the existing worker's Testnet token and configure its
`WHEELWIN_BOT_NETWORK=testnet` mode after adding that mode to the worker code.
Keep the existing Testnet Mini App URL in BotFather; do not set it to Mainnet.

The bot repository currently has no network-mode switch. Before creating the
Mainnet worker, add a mode branch there: Testnet mode sends only the two rows
above; Mainnet mode sends only one Mainnet Mini App button and changes its
profile description to Mainnet-only. Deploy it as a second Railway service
with its own `TELEGRAM_BOT_TOKEN` secret and `WHEELWIN_BOT_NETWORK=mainnet`.
Keep the existing worker in Testnet mode. Each polling worker must have exactly
one bot token; do not run two pollers for the same token.

For `@WheelWinMainnetBot`, create/claim the bot in BotFather, then use
`/mybots` → select bot → **Bot Settings** → **Configure Mini App** to enable
its Main Mini App at `https://wheelwin-main.vercel.app/`. Configure its chat
menu button (or its `/start` responder) to launch only this Mainnet app; add no
Testnet, YouTube, Facebook, Community, or channel row. The in-game handoff now
uses this bot and carries only the opaque handoff ID in `startapp`.

The existing worker uses long polling via `getUpdates`; it does not need a
webhook. The second worker should also use long polling with its own token, so
do not configure a webhook for either bot unless the worker is deliberately
migrated to an owner-controlled webhook receiver. The Main App/menu/deep-link
launch and server-side `initData` validation do not themselves require a
webhook.

## Railway setup sequence

The existing bot worker is in Railway project `industrious-commitment` as
service `wheelwin-telegram-bot`; keep its Testnet `TELEGRAM_BOT_TOKEN` secret.
Create a second service in that project from the same bot repo after its code
supports `WHEELWIN_BOT_NETWORK`; give it the newly created Mainnet bot token.
The separate game servers are `wheelwin` (Testnet) and
`positive-clarity` (Mainnet), both rooted at `/server` and using
`server/package.json`'s `npm start` (`node app.js`).

In BotFather:

1. Select existing `@wheel_win_bot` through `/mybots`; keep its Testnet Mini App
   URL and current Testnet identity. The current keyboard is generated by the
   Railway worker, so the row order and Mainnet removal are worker-code changes.
2. Use `/newbot` to create `@WheelWinMainnetBot` if it is not already created;
   save the returned token directly into protected Railway variables.
3. In `/mybots` → select `@WheelWinMainnetBot` → **Bot Settings** →
   **Configure Mini App**, enable its Main App with
   `https://wheelwin-main.vercel.app/`. Set its single menu button to this app.
   Do not add social links or a Testnet launch row.

In Railway, update the worker and backend service variables according to the
table below. For Mainnet, enter the new bot token in both the Mainnet worker's
`TELEGRAM_BOT_TOKEN` and the Mainnet backend's `TELEGRAM_MAINNET_BOT_TOKEN`;
both are protected secrets for the same bot identity. Keep Testnet's token
separate. Deploy each worker/server only after the owner approves the code
release; no webhook is needed with the current polling worker.

## Railway variables for this separation

| Service | Required Telegram/network variables |
|---|---|
| Testnet Telegram worker | `WHEELWIN_BOT_NETWORK=testnet`, existing `TELEGRAM_BOT_TOKEN` |
| Mainnet Telegram worker (new service) | `WHEELWIN_BOT_NETWORK=mainnet`, new `TELEGRAM_BOT_TOKEN` secret |
| Testnet game server (`wheelwin`) | `TON_NETWORK=testnet`, existing `TELEGRAM_BOT_TOKEN` |
| Mainnet game server (`positive-clarity`) | `TON_NETWORK=mainnet`, `TELEGRAM_MAINNET_BOT_TOKEN` (same new Mainnet bot secret) |

Keep each service's existing network-specific backend URL, persistent storage,
and payment/runtime variables unchanged. Mainnet's other required variables
remain those documented in [Mainnet README](../../server/mainnet/README.md).

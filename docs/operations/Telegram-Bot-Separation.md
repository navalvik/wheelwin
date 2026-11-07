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

The repository contains no Bot API calls, webhook receiver, polling worker,
or inline-keyboard builder. `YOUTUBE WHEELWIN`, `TESTNET`, and `MAINNET` are
not defined in the source tree. The code here cannot identify which external
bot host/provider currently sends the message containing those buttons; the
owner must inspect the existing bot's webhook/polling provider or hosting
account to locate it.

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

For `@wheel_win_bot`, keep its existing token and configure the current
external responder as above. In BotFather, retain the current Testnet Mini App
URL if its Main App/menu button is already correct; do not set it to Mainnet.

For `@WheelWinMainnetBot`, create/claim the bot in BotFather, then use
`/mybots` → select bot → **Bot Settings** → **Configure Mini App** to enable
its Main Mini App at `https://wheelwin-main.vercel.app/`. Configure its chat
menu button (or its `/start` responder) to launch only this Mainnet app; add no
Testnet, YouTube, Facebook, Community, or channel row. The in-game handoff now
uses this bot and carries only the opaque handoff ID in `startapp`.

To locate an existing webhook, the owner can check the bot's `getWebhookInfo`
with its token without printing the token or full response. An empty webhook
URL means the bot may instead use an external `getUpdates` polling worker; that
provider must be located separately. A responder must receive `/start` updates
by webhook or polling to send the inline keyboard. The Main App/menu/deep-link
launch and server-side `initData` validation do not themselves require a
webhook. Add a webhook for the new bot only if an owner-controlled responder is
being configured to serve it. Never point two different bot identities at the
same webhook controller unless it selects the correct token for each bot.

## Railway variables for this separation

| Service | Required Telegram/network variables |
|---|---|
| Testnet | `TON_NETWORK=testnet`, existing `TELEGRAM_BOT_TOKEN` (retain current value) |
| Mainnet | `TON_NETWORK=mainnet`, `TELEGRAM_MAINNET_BOT_TOKEN` (new Railway secret) |

Keep each service's existing network-specific backend URL, persistent storage,
and payment/runtime variables unchanged. Mainnet's other required variables
remain those documented in [Mainnet README](../../server/mainnet/README.md).

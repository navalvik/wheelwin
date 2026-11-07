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

## BotFather setup

For `@wheel_win_bot`, retain the current `YOUTUBE WHEELWIN` entry first and
`TESTNET` launch entry second, and remove the `MAINNET` entry. Point the
`TESTNET` entry to the existing Testnet Mini App/deep link. Do not change its
token.

For `@WheelWinMainnetBot`, configure the Main App/Mini App URL as
`https://wheelwin-main.vercel.app/` and expose only its Mainnet launch entry.
Do not add Testnet or social links. The in-game Testnet-to-Mainnet handoff now
uses this bot and carries only the opaque handoff ID in `startapp`.

The repository has no Telegram Bot API webhook receiver or menu keyboard
builder. These BotFather/menu settings are therefore operator configuration,
not code deployment. A webhook is not required for Mini App launch or
`initData` validation. If the existing bot uses a webhook outside this
repository, leave the Testnet webhook unchanged; configure the new bot's
webhook only for that external receiver, otherwise leave it unset. Do not
point both bot tokens at one bot identity.

## Railway variables for this separation

| Service | Required Telegram/network variables |
|---|---|
| Testnet | `TON_NETWORK=testnet`, existing `TELEGRAM_BOT_TOKEN` (retain current value) |
| Mainnet | `TON_NETWORK=mainnet`, `TELEGRAM_MAINNET_BOT_TOKEN` (new Railway secret) |

Keep each service's existing network-specific backend URL, persistent storage,
and payment/runtime variables unchanged. Mainnet's other required variables
remain those documented in [Mainnet README](../../server/mainnet/README.md).

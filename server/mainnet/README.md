# Mainnet payment runtime (offline integration stage)

This directory contains the Mainnet-only configuration, 64-wallet registry,
Toncenter client, incoming receipt ledger, financial ledger, and existing
refund/payout lifecycle adapters. The runtime shares the repository's generic
wallet-pool lifecycle and atomic JSON writer while keeping Mainnet catalog and
state under `MAINNET_ROOM_WALLET_DATA_DIR`.

Required identity is explicit: `TON_NETWORK=mainnet`, Toncenter Mainnet URL,
64 unique wallet records tagged `network: "mainnet"`, and an absolute durable
Mainnet data directory that does not overlap Testnet storage. Missing Mainnet
configuration never falls back to Testnet credentials, wallets, or storage.

Payout allocation matches the current Testnet rule: 95% winner, 4.9% owner,
and the remaining 0.1% plus integer-rounding remainder retained as reserve.
Payment runtime initialization creates its Mainnet stores and wallet snapshot,
but does not poll the chain, accept live payments, sign, broadcast, refund, or
pay out. The outgoing adapter remains disabled by default.

Testnet template components include `server/payment/WalletPoolRegistry.js`,
`server/payment/DurableJson.js`, the incoming-payment matcher and receipt
stores, `server/payment/ledger/RoomLedger.js`, and the Testnet refund/payout
lifecycle classes. Those Testnet files are unchanged. Existing Page1–Page6,
gameplay recovery, and R2 archive code are outside this integration.

# Native GRAM Testnet refund fee estimator — integration status

This branch is an **isolated staging branch**, not a release candidate.

The staged `ToncenterTestnetRefundFeeEstimator` is a read-only diagnostic adapter. Its `inspectRefundFee` method emulates a Wallet V4R2 simple-send body using Toncenter Testnet and reports a non-authorizing estimate. Its `estimateRefundFee` method deliberately throws `REFUND_FEE_NOT_GUARANTEED`; this must not be changed to return an execution-authorizing estimate without a separately verified fee-safety design.

## Mandatory gates before integration

1. Add compatible, pinned `@ton/core` and `@ton/ton` versions to `server/package.json` **and** regenerate/commit `server/package-lock.json`. Do not change the CI workflow to bypass `npm ci`.
2. Stage and run the offline test suite from the Codex archive, including malformed wallet state, mismatched network and wallet identity, and fee-estimate failure paths.
3. Verify that no live signer, broadcaster, wallet secrets, runtime payment flag, or refund submitter is enabled by this module.
4. Require successful isolated safety tests and Testnet release gate before considering a merge into `restore/testnet-64-wallet-page4`.
5. Keep `LIVE_PAYMENT_ACCEPTANCE_ENABLED=false`, Railway and Vercel unchanged, and do not send real transfers during integration.

The successful Wallet V4 decoder/signature checks at commit `952ce604b79bb89602ce39b8b7d97c6921edd1d3` are the baseline for this branch. A Toncenter `estimateFee` response is not a guaranteed final fee or an authorization to spend room-wallet funds.

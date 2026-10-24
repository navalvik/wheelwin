# Issue #17: Testnet native GRAM refund safety

Date: 2026-10-24

Issue: https://github.com/navalvik/wheelwin/issues/17

Base: `restore/testnet-64-wallet-page4` at `952ce604b79bb89602ce39b8b7d97c6921edd1d3`.
Branch: `codex/issue-17-testnet-refund-safety`.

## Release decision

**BLOCKED for live acceptance and transfers.** This change integrates and hardens the offline refund path. It does not provide a production fee guarantee, a production signing service, or permission to move funds. `LIVE_PAYMENT_ACCEPTANCE_ENABLED = false` and the default `refundSubmitter = null` remain unchanged. `NativeGramRefundTransferPlan` validation is unchanged.

The advisory estimator, its 18 tests and pinned TON dependencies were copied from PR #15 commit `766c4804` into this new branch without changing that PR. `inspectRefundFee()` still returns `finalized: false` and `executionEligible: false`. `estimateRefundFee()` still throws `REFUND_FEE_NOT_GUARANTEED` after a successful inspection. Neither a simulation nor a conservative margin is an execution authorization.

## Fee assurance investigation

The deployed Wallet V4R2 simple-send request authenticates the wallet ID, expiry, seqno and messages/send modes. It has no signed maximum-total-fee field. The wallet accepts the request and commits its incremented seqno before processing its simple-send actions. See the [official Wallet V4 source](https://github.com/ton-blockchain/wallet-contract/blob/main/func/wallet-v4-code.fc), especially `recv_external`.

[TON sending modes](https://docs.ton.org/foundations/messages/modes) change how forwarding charges and message values are handled:

| Candidate | Why it does not satisfy this task |
| --- | --- |
| Mode 1 / 3 | Forward fees come from the account in addition to the signed transfer value. No total fee ceiling is enforced. Mode 3 can skip a failed action; acceptance is not successful delivery. |
| Mode 0 / 2 | Deducts forwarding fees from message value; does not make the existing exact-net plan enforce all wallet costs. |
| Mode 64 | Carries remaining inbound message value; does not create a per-player budget for an externally signed refund. |
| Mode 128 / 160 | Spends remaining wallet balance, potentially including other players' funds; forbidden. |

Storage charges depend on elapsed time; gas and forwarding charges depend on execution/configuration. See [TON transaction fees](https://docs.ton.org/foundations/fees). Re-reading wallet state around RPC emulation does not freeze the state/configuration at future inclusion. A post-transfer overrun check can detect a subsidy but cannot undo it. A larger reserve can overcharge the player; returning the difference itself incurs another fee. **Our conclusion:** no safe pre-send guarantee for the requested exact-fee/no-subsidy policy has been established under the permitted V4R2 design. No alternate contracts, escrow, plugins or send-all workaround were introduced.

V4R2 also has no V5-style network-specific default wallet ID. See [TON wallet interaction documentation](https://github.com/ton-blockchain/docs/blob/main/content/contracts/standard/wallets/interact.mdx). Testnet-only keys and independently authenticated network/account state remain necessary; a friendly address flag is not cryptographic replay protection.

## Integrated flow and ownership

1. Existing room/payment owners create obligations from settled payments for cancelled rooms. No room/gameplay ownership changes; the 64-wallet pool, exactly-three-player start gate and 300-second timer are unchanged.
2. `TestnetOutgoingRefundProvider` resolves the settled intent and verifies room, player, incoming transaction, asset, network, amount and payer before choosing its wallet.
3. The existing plan builder validates a fee quote. The immutable plan is persisted before any attempt. Real advisory estimates cannot reach the signer.
4. `RefundObligationStore` obtains an exclusive filesystem transition lock, reloads authoritative state and compares it with the expected record. It persists a per-source-wallet hold and `SUBMISSION_UNKNOWN` before signing. Another worker cannot claim the same obligation or use the same wallet until the previous obligation is complete. Different wallets can progress independently.
5. The injected signer returns a signed V4 body. Only a frozen allowlist of scalar fields reaches verification/broadcast. The existing decoder and independent Ed25519 verifier authenticate the actual bytes against independently supplied wallet state.
6. The plan store exclusively persists the signed body cell hash, seqno, wallet ID and expiry before broadcast. It stores neither private keys nor spendable signed BOCs. Repeating this reservation refuses broadcast, including direct provider retries.
7. A broadcaster acknowledgement records submission only. Exceptions/ambiguous responses remain UNKNOWN, with fixed public diagnostic codes. Adapter text never becomes a log or durable error.
8. Finality matches the persisted signed body hash as well as source, destination, transaction and net amount. It requires successful non-bounced execution and an actual fee exactly equal to the reserved fee. Missing fees, overruns and unused reserves cannot complete the obligation.
9. Restart/UNKNOWN reconciliation is read-only and can work with no signer/broadcaster. It searches by the saved signed body identity; amount/recipient equality alone is insufficient. No match or conflicting evidence produces a durable reconciliation hold, never a resend.

## Adapter contract and remaining blockers

- **Critical — fee assurance:** no production estimator satisfies the existing plan authorization contract. Synthetic finalized quotes in tests are explicitly fixtures, not a suggested production implementation.
- **Critical — production adapters:** a key-isolated, authorized Testnet signer, independently authenticated wallet-state reader, external-message-envelope broadcaster, and finalized outgoing/recipient observation adapter still need independent review and deployment-specific provisioning. This PR wires their boundaries offline; it does not pretend mocks are production services.
- The observer's `signedBodyHash` must be the actual inbound V4 body cell hash from the independently observed source transaction, not the BOC byte SHA, signer metadata or a broadcaster echo. `actualFeeAtomic` must cover the full attributable network charge from authoritative execution evidence, without double-counting the action share of forwarding fees. `success`/`bounced` must establish delivery outcome, including recipient execution/bounce tracing. No concrete live mapper is claimed here.
- **High — crash and filesystem operations:** file content is fsynced, and POSIX directory metadata is fsynced. Windows has no directory-fsync equivalent here: sudden power-loss durability is unproven. Multi-host/shared-volume hard-link/locking semantics require validation. All workers must use this implementation and the same durable namespace.
- A crash while the transition lock exists is intentionally fail-closed. Do not delete a lock because it is old. Stop competing workers, inspect the wallet hold, plan, signed-body receipt and chain history, and reconcile before an audited recovery. A hold published before UNKNOWN can leave a PENDING record with no automatic retry permission.
- Existing completed records remain readable. An older pending/submitted obligation lacking the new signed-body identity or actual-fee evidence cannot be silently upgraded or auto-completed. It requires reconciliation. No legacy financial migration is performed.
- **High — operational validation:** no real transfers, three-device test, recipient tracing, key custody validation or hosting-volume crash drill was performed. These remain release blockers independently of green offline tests.

## Publication controls

The Testnet release gate now runs for PRs targeting the requested base and includes the new integration/estimator/decoder tests. It has no transfer or deployment step. Branch-specific `git.deploymentEnabled: false` in both Vercel config roots prevents this implementation branch from creating automatic Vercel deployments. No hosting settings or acceptance flags are enabled.

Exact validation results are recorded in `AI_CONTEXT/CLINE_REPORTS/2026-10-24_issue17_testnet_refund_safety.md` and the Draft PR.

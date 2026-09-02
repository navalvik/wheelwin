# R18-S16 — Forensic Audit of Olga's 0.026 GRAM Payment

Date: 2026-09-02

Task: Determine whether Olga's TESTNET wallet debit of `-0.026 GRAM` during the completed game session is a required Deposit operation, a duplicate/accidental payment, a deploy/storage attach, a wrong amount, or unrelated.

Classification:

```text
LEGITIMATE_REQUIRED_PAYMENT
```

No source changes. No deploy. No new game. No outbound transactions from this investigation. Secrets were used only locally if present and are not written here.

---

## 1. Executive conclusion

The `-0.026 GRAM` wallet line is **Olga's Deposit FundSeat** for seat 0. It is not the Deposit deploy, not GameEscrow STAKE, and not a duplicate of either.

At `2026-09-02T19:28:38Z` (22:28 UTC+3) Olga's wallet sent **one** external transaction with **three** internal messages:

| # | Value | Destination | Meaning |
| --- | --- | --- | --- |
| 1 | `10000000` nano (0.01 TON) | Deposit `EQCXa3dZ-…5piz` | StateInit **deploy** (Role A) |
| 2 | `26000000` nano (0.026 TON) | same Deposit | **FundSeat** opcode `0x46554E44` (`FUND`), seat `0` |
| 3 | `2500000000` nano (2.5 TON) | GameEscrow `EQAGNeY_…4-wk` | **STAKE** opcode `0x5354414B` (`STAK`), playerIndex `0` |

Wallet UI showed the FundSeat as `-0.026 GRAM` to testnet non-bounceable `0QCXa3dZ-…5n78` (user truncation `QQCX…5n78`) and the deploy as `Contract deployed` on the same account. It showed `-2.5 GRAM` to testnet bounceable `kQAGNeY_…41eu`.

On-chain Deposit getters after the game:

```text
status              = 3 FULL
expected_stake0     = 25000000
creation_fee/seat   = 1000000
expected_amount0    = 26000000
credited_amount0    = 26000000
expected_stake1/2   = 10000000
expected_amount1/2  = 11000000
credited_amount1/2  = 11000000
total_credited      = 48000000
surplus_nano        = 0
```

`0.026 TON` equals `expected_stake0 + creationFeePerSeat` for profile **`1:2`** (`baseStake=1`, `sectorCount=2`) from the authoritative env map. That amount was **credited as FundSeat**, not left as unexplained storage. Deploy `0.01 TON` is a separate required attach and is **not** part of `credited_amount0`.

---

## 2. Exact transaction identification

Olga wallet (bounceable, public, established across prior TESTNET sessions):

```text
EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le
```

External wallet transaction (TonCenter `getTransactions` on that address):

```text
utime     1788377318
iso       2026-09-02T19:28:38.000Z
lt        93989367000001
hash      xxpws/venRvfviRo8oVuJLSfR79yAiO9W93GOPZYB2w=
account   0:BDAB0280CBBDA45F5A0FB6BC97FA0E72E380769986440761D574901E269AE56B
fee       5597769 nano
in_msg    empty (wallet-originated)
out_msgs  3
```

Deposit-account internals created by those out-messages (same `utime`):

```text
deploy    lt=93989367000003  hash=dK1XDUeTNON3LCc7t6Nnj7ANt3k2l0HNuu4epJ/Wfkk=
          in_value=10000000  StateInit=true  no bounce-out

fundseat   lt=93989367000004  hash=zlArKT5AtDkMOe4687donT1jcrosOH2PS76CgNro/MA=
          in_value=26000000  StateInit=false no bounce-out
```

---

## 3. Sender / recipient identification

| Role | Address | UI fragment |
| --- | --- | --- |
| Sender (Olga) | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` | Olga's TESTNET wallet |
| Deposit (bounceable) | `EQCXa3dZ-kfDdVnuXdUD0QLxyyPoXYHW4NIDhTPnn5Ha5piz` | |
| Deposit (testnet non-bounceable) | `0QCXa3dZ-kfDdVnuXdUD0QLxyyPoXYHW4NIDhTPnn5Ha5n78` | `QQCX…5n78` |
| GameEscrow (bounceable) | `EQAGNeY_BoRx4WPdhqaNKu40o5hT0IdaubiHaEUgkMuX4-wk` | |
| GameEscrow (testnet bounceable) | `kQAGNeY_BoRx4WPdhqaNKu40o5hT0IdaubiHaEUgkMuX41eu` | `kQAG…41eu` |

Same three player wallets as earlier rooms (mQk9 and others):

```text
Olga  EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le
Lena  EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp
Bob   EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM
```

Olga's address was confirmed from prior public session records and from this chain history. Mnemonics / `.env` secrets are not copied here.

---

## 4. Blockchain evidence

Decoded bodies of Olga's three out-messages:

```text
msg0  10000000  dest=Deposit   StateInit present   empty body (deploy protocol)
msg1  26000000  dest=Deposit   opcode=0x46554E44 (FUND)  next8=0  (seat 0)
msg2  2500000000 dest=Escrow   opcode=0x5354414B (STAK)  next8=0  (playerIndex 0)
```

`0x46554E44` is `FUND_SEAT_OPCODE` in `server/deposit/RealTonDepositBlockchainSource.js` and `client/src/payment/buildFundDepositTransaction.js`.  
`0x5354414B` is `GAME_ESCROW_STAKE_OPCODE` in `client/src/payment/buildTonConnectPaymentTransaction.js`.

Deposit later received:

```text
19:30:16Z  Bob   EQAtggW7…  11000000  credited (no bounce)
19:32:50Z  Lena  EQDeWBnz…  11000000  credited (no bounce)
```

Then two bounced probes (not Olga, not FundSeat credits):

```text
19:32:52Z  EQD_N0hr…  in 10000000  out ~9645799 back
19:33:04Z  EQAyni3Y…  in 50000000  out ~49645799 back
```

Deposit live state at investigation time: `active`, balance `53907666` nano. Status getter `FULL`. Surplus `0`. The 0.026 TON is inside `credited_amount0`, not an extra unaccounted attach.

At `19:36:17Z` Olga received `4270000000` nano from GameEscrow `EQAGNeY_…`. That inbound is settlement/recovery completion, not the 0.026 debit.

---

## 5. Contract identification

**`EQCXa3dZ-…5piz` / `0QCXa3dZ-…5n78` is the Deposit contract** for this session:

- First inbound is StateInit deploy from Olga.
- Subsequent inbounds use FundSeat opcode / FundSeat amounts.
- Getters expose `expected_stake*`, `creation_fee_per_seat`, `credited_amount*`, `status` — Deposit ABI, not GameEscrow.

**`EQAGNeY_…4-wk` / `kQAGNeY_…41eu` is GameEscrow**:

- Receives STAKE `0x5354414B` with `requiredGram`-scaled nanotons (`2.5 TON` for Olga).
- Later pays Olga `4.27 TON`.
- Remaining escrow balance at investigation: `81351594` nano, state `active`.

The `-0.026 GRAM` recipient is the Deposit contract, not GameEscrow.

---

## 6. Code path producing the payment

```text
Olga taps Page4 confirm
  → Page4Payment.jsx handleConfirmInTelegramWallet
  → resolveEntryPaymentComponents()  (creator: deploy + fund + stake)
  → buildEntryPaymentTransaction({
        includeDeploy, includeFund, includeStake,
        deployValueNanotons: package.deployValueNanotons,   // 10000000
        myExpectedAmountNanotons: deposit.myExpectedAmountNanotons, // 26000000
        requiredGram: paymentRequest.requiredGram           // 2.5
     })
  → messages:
        buildDepositDeploymentTransaction  amount=10000000 + stateInit
        buildFundDepositTransaction        amount=myExpectedAmountNanotons + FUND/seat
        buildTonConnectPaymentTransaction  amount=toNano(requiredGram) + STAK/index
  → strip totalNanotons
  → tonConnectUI.sendTransaction({ validUntil, messages })
  → wallet broadcasts one external tx with those three internals
```

Authoritative amount for the 0.026 message is **not computed on the client**:

1. `resolveDepositOrchestrationFinancials` reads `TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE` and `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO`.
2. For each player identity, `resolveExpectedStakeNano` uses key ``${baseStake}:${sectorCount===2?2:1}``.
3. `DepositOrchestrator` sets `expectedAmount = Number(expectedStakeNano + creationFeePerSeat)`.
4. `projectDepositForPlayer` exposes `myExpectedAmountNanotons: seat.expectedAmount`.
5. `buildFundDepositTransaction` copies that integer into TonConnect `messages[].amount` and attaches FundSeat payload. It does not add deploy value, GameEscrow stake, or a local sector formula.

`26_000_000` in `buildEntryPaymentTransaction.test.js` is a **fixture** proving a 2-sector FundSeat string is passed through unchanged. Live 0.026 did not originate from that test literal; it originated from profile `1:2` + fee on the server.

---

## 7. Intended architecture comparison

Authoritative sources (implementation + tests + env example), not names alone:

| Quantity | Intended source | Live value this session |
| --- | --- | --- |
| Deposit deploy (A) | hardcoded `DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"` | 0.01 TON, StateInit message |
| Creation fee (B) | `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO` | 1000000 |
| Deposit stake (C) | env map by `baseStake:sectorCount` | seat0 `25000000` (`1:2`); seats 1/2 `10000000` (`1:1`) |
| FundSeat expectedAmount (D) | `C + B` per seat | seat0 `26000000`; seats 1/2 `11000000` |
| GameEscrow STAKE | `calculateRequiredGram(baseStake, sectorCount)` then `toNano` | Olga 2.5 TON |

`resolveDepositOrchestrationFinancials.js` states Deposit nanoton parameters are **not** derived from PaymentSession `requiredGram`. L.23 `FINANCIAL_ENV` and `server/.env.example` use the same map:

```text
{"1:1":"10000000","1:2":"25000000","10:1":"100000000","10:2":"250000000"}
```

Deploy value is independent of B/C/D (`DepositOrchestrator.js` Role A comment). Activation verification does not send TON. FundSeat is a required per-seat credit; an empty deploy-only contract cannot mark seats funded.

Olga's 2.5 GRAM GameEscrow amount is `1×baseStake + 1.5×baseStake` with `baseStake=1`, `sectorCount=2` (`calculateRequiredGram`). That is a different contract and a different formula.

---

## 8. Why 0.026 GRAM is required, and why exactly that amount

Required: without FundSeat, seat 0 is not credited, Deposit cannot reach `FULL`, and later seats / GameEscrow lifecycle cannot complete as designed. This session did reach `status=3 FULL` with `credited_amount0=26000000`.

Exact amount:

```text
profile 1:2 expectedStake = 25000000
+ creationFeePerSeat      =  1000000
= expectedAmount0         = 26000000 = 0.026 TON
```

On-chain `get_expected_amount0` equals `get_credited_amount0` equals the wallet FundSeat message. No extra nano.

The 0.026 TON is **consumed as credited FundSeat**. The separate 0.01 TON deploy remains operational contract balance (not in `credited_amount*`). They must not be added together into a single “0.036 deposit payment”; the wallet listed them as deploy vs 0.026 call.

---

## 9. Dependence on sectors / base rate / game entry

| Depends on | 0.026 FundSeat | 2.5 GameEscrow |
| --- | --- | --- |
| `baseStake` | yes (`1` in profile key `1:2`) | yes (`calculateRequiredGram`) |
| `sectorCount` | yes (`2` selects map value `25000000` not `10000000`) | yes (second sector ×1.5) |
| GameEscrow `requiredGram` | **no** (explicit non-derivation) | that field **is** the STAKE |
| Deposit deploy 0.01 | **no** (independent Role A) | no |

Lena and Bob credited `11000000` each (`1:1`). That is independent evidence that FundSeat follows **per-player identity**, not a single room-wide 0.026.

---

## 10. Final verdict

```text
LEGITIMATE_REQUIRED_PAYMENT
```

Not `UNNECESSARY_PAYMENT`: FundSeat is the Deposit credit path.  
Not `BUG_DUPLICATE_PAYMENT`: deploy 0.01, FundSeat 0.026, and STAKE 2.5 are three different messages, opcodes, and ledgers.  
Not `WRONG_AMOUNT`: credited amount matches on-chain expected_amount0 and the env profile `1:2` + fee.  
Not `UNRELATED_TRANSACTION`: same wallet, same second, same Deposit address as Contract deployed, FundSeat opcode.  
Not `INCONCLUSIVE` for the debit itself.

The session-history ZIP for **this** 19:28 completed room is **not** in the workspace (latest local forensic dump is mQk9 `SETUP_EXPIRED` at 18:03, all `1:1` / 0.011). Verdict is from TonCenter + production code/tests, not from that earlier archive.

---

## 11. Evidence table

| Claim | Evidence |
| --- | --- |
| Time matches wallet ~22:28 | `utime=1788377318` → 19:28:38Z = 22:28 UTC+3 |
| `-0.026` recipient is Deposit | out_msg amount 26000000 to `EQCXa3dZ-…` / `0QCXa3dZ-…5n78` |
| `-2.5` recipient is GameEscrow | out_msg amount 2500000000 to `kQAGNeY_…41eu` |
| Contract deployed is same Deposit | first out_msg StateInit + deposit in_msg init=true, 10000000 |
| 0.026 is FundSeat | opcode `0x46554E44`, seat 0; getter `credited_amount0=26000000` |
| Amount formula | `25000000+1000000`; getters `expected_stake0` / `creation_fee` / `expected_amount0` |
| Not deploy value | deploy is 10000000, not in credited amounts |
| Not GameEscrow | different address, opcode `STAK`, 2.5 TON |
| Not duplicate | three messages; later Lena/Bob 0.011 credits distinct |
| Code path | Page4 → `buildEntryPaymentTransaction` → `buildFundDepositTransaction` |
| Map is authoritative | `.env.example` + L.23 `FINANCIAL_ENV` + Railway-established JSON from prior reports |

---

## 12. Relevant source files and locations

| File | Location | Role |
| --- | --- | --- |
| `client/src/pages/Page4Payment.jsx` | ~787–857 | builds one `sendTransaction` from projection + paymentRequest |
| `client/src/game/session/page4PaymentPhase.js` | `resolveEntryPaymentComponents` ~168–189 | creator includes deploy+fund+stake |
| `client/src/payment/buildEntryPaymentTransaction.js` | ~88–180 | concatenates three authoritative messages |
| `client/src/payment/buildFundDepositTransaction.js` | `FUND_SEAT_OPCODE`, ~180–199 | 0.026 amount + FUND payload |
| `client/src/payment/buildDepositDeploymentTransaction.js` | ~64–69 comment in orchestrator; builder ~191–203 | 0.01 + StateInit, no body |
| `client/src/payment/buildTonConnectPaymentTransaction.js` | `GAME_ESCROW_STAKE_OPCODE`, `requiredGramToNanotonString` | 2.5 STAKE |
| `server/deposit/DepositOrchestrator.js` | Role A `10000000`; bindings `expectedAmount = stake + fee` ~337–345 | D vs A |
| `server/deposit/resolveDepositOrchestrationFinancials.js` | header; `profileKey`; map lookup | C from env, not GRM |
| `server/deposit/projectDepositForPlayer.js` | `myExpectedAmountNanotons` ~348 | client amount authority |
| `server/deposit/RealTonDepositBlockchainSource.js` | `FUND_SEAT_OPCODE = 0x46554E44` | on-chain opcode match |
| `server/payment/calculateRequiredGram.js` | first sector ×1, second ×1.5 | 2.5 GRAM only |
| `server/tests/depositOrchestrator.r179l23.test.js` | `FINANCIAL_ENV` `1:2`=`25000000` | intended map |
| `server/.env.example` | lines 117–119 | same map + fee |
| `client/src/payment/buildEntryPaymentTransaction.test.js` | `"26000000"` fixture | pass-through, not live source |

---

## 13. Security note

This report contains only public TESTNET addresses, TonCenter transaction hashes/logical times, getter integers, and source paths. It does **not** contain seed phrases, private keys, mnemonics, API secrets, passwords, or private environment variable values.

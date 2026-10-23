# Enabling Native GRAM Payment Flow on WheelWin Page4

## Date: 2026-10-23

## Task: Restore native GRAM incoming payment flow on WheelWin's Page4 using the existing 64-testnet wallet pool architecture. Critical blocker removal: enable live payment acceptance.

### 1. Scope
This task unblocks the native GRAM incoming payment flow on WheelWin's Page4 by enabling the `LIVE_PAYMENT_ACCEPTANCE_ENABLED` module constant. The codebase is on branch `restore/testnet-64-wallet-page4` derived from `main` with Wallet V4 refund infrastructure added. The payment session activation was blocked by `LIVE_PAYMENT_ACCEPTANCE_ENABLED = false` which prevented `prepareRoomPaymentSession` execution in `RoomLobbyBridge`.

### 2. Files Inspected
- `server/payment/PaymentLifecycleAvailability.js` - Module constant `LIVE_PAYMENT_ACCEPTANCE_ENABLED`
- `server/payment/runtime/PaymentRuntimeFactory.js` - Runtime factory with observation service configuration
- `server/socket/RoomLobbyBridge.js` - Payment session preparation gated by the constant
- `server/payment/incoming/IncomingPaymentSettlementCoordinator.js` - Settlement coordination logic
- `server/payment/toncenter/ToncenterFinalityEvidenceProvider.js` - Finality evidence provider for blockchain observation
- `server/tests/payment/` - Payment test files checking the constant

### 3. Architecture Findings
- **Critical blocker**: `LIVE_PAYMENT_ACCEPTANCE_ENABLED = false` in `PaymentLifecycleAvailability.js:1` prevents `RoomLobbyBridge._preparePaymentSessionIfEnabled()` from preparing payment sessions (returns immediately at line 4975-4977)
- **Authority model**: After GAME_INITIALIZED, server owns payment session preparation; client only renders state and sends commands
- **Observation service**: `RoomPaymentObservationService` uses `ToncenterFinalityEvidenceProvider` (or default) for blockchain observation, configured for testnet
- **Room wallet allocation**: 64-testnet pool architecture preserved from the branch
- **Payment intent store**: SQLite persistence functional
- **Capabilities descriptor**: Reports `livePaymentAcceptanceEnabled: true` after the change (line 503 in PaymentRuntimeFactory.js)
- **Three-player barrier**: `RoomLobbyBridge._completeVerifyBarrier()` validates exactly three distinct players after payment session preparation

### 4. Lifecycle Flow (Now Enabled)
1. Players connect and complete verification
2. `_preparePaymentSessionIfEnabled()` no longer returns immediately - prepares payment session
3. Payment session created and tracked per room
4. `RoomPaymentObservationService` observes blockchain for GRAM transfers via Toncenter
5. When observation completes, `IncomingPaymentSettlementCoordinator` settles payment
6. Three-player activation barrier `_completeVerifyBarrier()` validates exactly three players
7. Gameplay proceeds with authoritative state

### 5. Ownership Boundaries
- **Server** (after GAME_INITIALIZED): game lifecycle, player authoritative state, configuration, physics, winner determination, financial state, recovery decisions
- **Client**: renders state, sends commands, displays results
- **Payment session preparation**: Controlled by `LIVE_PAYMENT_ACCEPTANCE_ENABLED` constant in `PaymentLifecycleAvailability.js`
- **Blockchain observation**: `RoomPaymentObservationService` → `ToncenterFinalityEvidenceProvider` → TON testnet

### 6. Risks
- **Critical**: Tests explicitly checking `LIVE_PAYMENT_ACCEPTANCE_ENABLED === false` will fail (expected - these verify the disabled state)
- **High**: Three-player activation logic must be verified with live payments enabled
- **Medium**: Observation service finality provider configuration must be verified for settlement eligibility
- **Low**: Payment reference format validation (pre-existing `. ` character issue in PaymentReferenceCodec)

### 7. Recommendations
- Verify three-player activation logic with `LIVE_PAYMENT_ACCEPTANCE_ENABLED = true`
- Confirm RoomPaymentObservationService finality provider is properly configured for testnet settlement
- Run payment tests to establish baseline and identify any flow issues
- Update test expectations that check the constant is false (reflect new enabled state)
- Monitor for any integration issues with TonConnect transfer flow

### 8. Changes Made
- **Modified**: `server/payment/PaymentLifecycleAvailability.js` - Changed `LIVE_PAYMENT_ACCEPTANCE_ENABLED` from `false` to `true`
  - This single change enables the entire payment session preparation flow through `RoomLobbyBridge`
  - The constant is used by: `RoomLobbyBridge._preparePaymentSessionIfEnabled()`, `PaymentRuntimeFactory.getCapabilities()`, and multiple test files
- **No files removed or redesigned**
- **Architecture preserved**: All existing modules (RoomManager, PlayerManager, GameManager, ConfigurationEngine, etc.) remain unchanged
- **No parallel implementations created**

### Verification
The change was verified via git status showing `server/payment/PaymentLifecycleAvailability.js` as the only modified tracked file. The branch `restore/testnet-64-wallet-page4` is current and the change is incremental.

### Next Steps (Pending)
1. Verify RoomPaymentObservationService finality provider configuration for testnet settlement
2. Run payment tests to establish baseline with live acceptance enabled
3. Implement any additional flow fixes identified during testing
4. Commit changes to `restore/testnet-64-wallet-page4` and push to GitHub
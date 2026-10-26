/**
 * TON Connect submission boundary for a native WheelWin room-wallet payment.
 * The caller supplies a connected TonConnectUI-compatible adapter. No adapter
 * is constructed here and no server/client-supplied transaction can be sent
 * without wallet identity, network and immutable room deadline verification.
 * Wallet approval never counts as payment settlement.
 */
import { buildNativeGramPaymentTransaction } from "./nativeGramTransfer.js";
import { tonAccountIdentityOrNull } from "./gramPaymentAuthorization.js";

export async function submitNativeGramToConnectedWallet({ payment, walletAdapter, onSubmitted }) {
    if (!walletAdapter || typeof walletAdapter.sendTransaction !== "function")
        throw new Error("TON Connect wallet is unavailable");
    const account = walletAdapter.account;
    if (!account || account.chain !== "-3") throw new Error("A TON Testnet wallet is required");
    const sender = tonAccountIdentityOrNull(account.address);
    if (!sender) throw new Error("Connected wallet address is invalid");
    const expiry = payment?.expiresAt;
    if (!Number.isSafeInteger(expiry)) throw new Error("Missing authoritative payment expiry");
    const transaction = buildNativeGramPaymentTransaction(
        payment, account.address, Math.floor(expiry / 1000)
    );
    await walletAdapter.sendTransaction(transaction);
    // Never credit from a wallet SDK callback. The server verifies finality.
    if (typeof onSubmitted === "function") onSubmitted();
    return Object.freeze({ walletSubmitted: true, serverVerified: false, credited: false });
}

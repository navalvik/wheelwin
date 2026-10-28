/**
 * One official TON Connect UI instance per browser session.
 * Page4 can mount/unmount repeatedly (React StrictMode, recovery) without
 * creating second wallet connections. No payment transaction is created here.
 */
let ui = null;

export function getTonConnectUI() {
    if (typeof window === "undefined") return null;
    const TonConnectUI = window.TON_CONNECT_UI?.TonConnectUI;
    if (typeof TonConnectUI !== "function") return null;
    if (!ui) {
        ui = new TonConnectUI({
            manifestUrl: "https://wheelwin-nine.vercel.app/tonconnect-manifest.json",
            analytics: { mode: "off" }
        });
    }
    return ui;
}

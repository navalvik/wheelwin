import { useLanguage } from "../context/LanguageContext";
import { DEBUG_JUMP_ENABLED } from "../config/devMode";

export default function HeaderBar({
    message,
    messageClassName = "",
    nextEnabled = false,
    showNextButton = true,
    nextLabel,
    backEnabled = false,
    onBack,
    onNext,
    showJumpButton = false,
    onJump,
    showMainnetSwitch = false
}) {

    const { t } = useLanguage();

    const resolvedNextLabel = nextLabel ?? t("common.next");

    const isTestnet = typeof window !== "undefined" && (
        window.location.hostname.includes("nine") ||
        window.location.hostname.includes("testnet")
    );

    // R19-S111 — Testnet → Mainnet Telegram Mini App handoff.
    //
    // Authoritative Mainnet Mini App configuration (operator-confirmed in
    // BotFather): bot @wheel_win_bot, Main App enabled, Web App URL
    // https://wheelwin-main.vercel.app/. Telegram's native profile Launch App
    // path was verified on Android to create a fully authenticated Mainnet
    // session.
    //
    // Telegram documents web_app_open_tg_link as the native Mini App event for
    // opening t.me deep links. Its current event contract also accepts the
    // force_request flag. Use that native event directly when the underlying
    // Telegram WebView bridge is exposed, so Android is explicitly asked for
    // a fresh Main Mini App request instead of reusing a cached deep-link
    // result. This is intentionally narrower than changing server auth or
    // forwarding any credentials.
    const MAINNET_MINI_APP_DEEP_LINK = "https://t.me/wheel_win_bot?startapp=mainnet";
    const MAINNET_MINI_APP_PATH = "/wheel_win_bot?startapp=mainnet";

    const MAINNET_WEB_URL = "https://wheelwin-main.vercel.app";

    function resolveTelegramWebViewPostEvent() {

        if (typeof window === "undefined") {

            return null;

        }

        const postEvent = window.Telegram?.WebView?.postEvent;

        return typeof postEvent === "function"
            ? postEvent
            : null;

    }

    function resolveTelegramOpenTelegramLink() {

        if (typeof window === "undefined") {

            return null;

        }

        const openTelegramLink = window.Telegram?.WebApp?.openTelegramLink;

        return typeof openTelegramLink === "function"
            ? openTelegramLink
            : null;

    }

    const handleMainnetClick = () => {

        const postEvent = resolveTelegramWebViewPostEvent();

        if (postEvent) {

            postEvent("web_app_open_tg_link", false, {
                path_full: MAINNET_MINI_APP_PATH,
                force_request: true
            });

            return;

        }

        const openTelegramLink = resolveTelegramOpenTelegramLink();

        if (openTelegramLink) {

            openTelegramLink(MAINNET_MINI_APP_DEEP_LINK);

            return;

        }

        // Plain-browser fallback (unchanged behavior): no Telegram WebApp
        // runtime, or the required Telegram API is unavailable.
        window.location.replace(MAINNET_WEB_URL);

    };

    return (

        <div className={`headerBar${DEBUG_JUMP_ENABLED && showJumpButton ? " headerBar--dev" : ""}`}>

            <div className="left">

                {showMainnetSwitch && isTestnet && (
                    <button
                        type="button"
                        className="mainnetSwitchButton"
                        onClick={handleMainnetClick}
                    >
                        MAINNET
                    </button>
                )}

                {backEnabled && (
                    <button
                        type="button"
                        onClick={onBack}
                    >
                        {t("common.back")}
                    </button>
                )}

            </div>

            <div className={`center${messageClassName ? ` ${messageClassName}` : ""}`}>

                {message}

            </div>

            {DEBUG_JUMP_ENABLED && showJumpButton && (

                <div className="jump">

                    <button
                        type="button"
                        className="jumpButton"
                        onClick={onJump}
                    >
                        JUMP
                    </button>

                </div>

            )}

            <div className="right">

                {showNextButton && (

                    <button
                        type="button"
                        disabled={!nextEnabled}
                        onClick={onNext}
                    >
                        {resolvedNextLabel}
                    </button>
                )}

            </div>

        </div>

    );

}
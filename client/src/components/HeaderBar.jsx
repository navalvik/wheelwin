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

    // R18-S109 — Testnet → Mainnet Telegram Mini App handoff.
    //
    // Authoritative Mainnet Mini App configuration (operator-confirmed in
    // BotFather): bot @wheel_win_bot, Main App enabled, Web App URL
    // https://wheelwin-main.vercel.app/. The deep link below launches a
    // FRESH Mainnet Mini App session with a fresh Telegram-signed
    // tgWebAppData. It must go through Telegram's own link-opening API:
    // a raw cross-origin location.replace drops the Mini App launch context
    // and the Mainnet page loads with empty initData, which the server-side
    // HMAC gate correctly rejects (R18-S107 diagnosis). No Testnet initData
    // or tgWebAppData is ever forwarded, copied, or reconstructed here.
    const MAINNET_MINI_APP_DEEP_LINK = "https://t.me/wheel_win_bot?startapp";

    const MAINNET_WEB_URL = "https://wheelwin-main.vercel.app";

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
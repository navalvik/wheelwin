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

    // R19-S110 — Testnet → Mainnet Telegram Mini App handoff.
    //
    // Authoritative Mainnet Mini App configuration (operator-confirmed in
    // BotFather): bot @wheel_win_bot, Main App enabled, Web App URL
    // https://wheelwin-main.vercel.app/. Telegram's native profile Launch App
    // path was verified on Android to create a fully authenticated Mainnet
    // session. The Android Testnet → Mainnet path must therefore remain a
    // Telegram-native Main Mini App deep link, not a raw cross-origin URL.
    //
    // A NON-EMPTY startapp value is intentional here. The previous bare
    // `?startapp` link opened the Mainnet UI on Telegram Android but produced
    // an empty WebApp.initData session. Telegram's documented Main Mini App
    // deep-link format supports a start parameter, and using an explicit
    // value forces this handoff through the same Main Mini App deep-link
    // handling path while giving the launch a distinct request context.
    // The application does not consume this value; it is only a launch
    // marker. No Testnet initData or tgWebAppData is forwarded, copied, or
    // reconstructed here.
    const MAINNET_MINI_APP_DEEP_LINK = "https://t.me/wheel_win_bot?startapp=mainnet";

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
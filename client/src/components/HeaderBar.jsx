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

    const handleMainnetClick = () => {
        window.location.replace("https://wheelwin-main.vercel.app");
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
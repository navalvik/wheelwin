import { useCallback, useEffect, useState } from "react";

import { SHOW_TESTNET_WARNING } from "../config/features";
import { useLanguage } from "../context/LanguageContext";

import "../styles/testnetWarningOverlay.css";

const FADE_MS = 280;

const isTestnet = typeof window !== "undefined" && (
    window.location.hostname.includes("nine") ||
    window.location.hostname.includes("testnet")
);

const MAINNET_TITLE = "⚠️ MAINNET";
const MAINNET_BODY =
    "THIS PROJECT IS CURRENTLY RUNNING ON THE TON MAINNET.";
const MAINNET_WALLETS_ONLY = "USE TELEGRAM WALLET ONLY.";

/**
 * R6.5 — Page1 network warning overlay.
 * Visible once per page mount when SHOW_TESTNET_WARNING is true.
 * Testnet keeps the existing translated warning; Mainnet shows the
 * corresponding Mainnet warning instead of Testnet text.
 * Dismissed by clicking / tapping the warning card.
 */
export default function TestnetWarningOverlay() {

    const { t } = useLanguage();

    const [visible, setVisible] = useState(SHOW_TESTNET_WARNING);

    const [fading, setFading] = useState(false);

    useEffect(() => {

        if (!SHOW_TESTNET_WARNING) {

            setVisible(false);

        }

    }, []);

    const dismiss = useCallback(() => {

        if (fading || !visible) {

            return;

        }

        setFading(true);

        window.setTimeout(() => {

            setVisible(false);

            setFading(false);

        }, FADE_MS);

    }, [fading, visible]);

    if (!SHOW_TESTNET_WARNING || !visible) {

        return null;

    }

    const title = isTestnet ? t("welcome.testMode") : MAINNET_TITLE;
    const body = isTestnet ? t("welcome.testnetBody") : MAINNET_BODY;
    const wallets = isTestnet
        ? t("welcome.testnetWalletsOnly")
        : MAINNET_WALLETS_ONLY;

    return (

        <div
            className={
                fading
                    ? "testnetWarningOverlay testnetWarningOverlay--fading"
                    : "testnetWarningOverlay"
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="testnet-warning-title"
        >

            <button
                type="button"
                className="testnetWarningOverlay__card"
                onClick={dismiss}
            >

                <div
                    id="testnet-warning-title"
                    className="testnetWarningOverlay__eyebrow"
                >

                    {title}

                </div>

                <p className="testnetWarningOverlay__body">

                    {body}

                </p>

                <p className="testnetWarningOverlay__body">

                    {wallets}

                </p>

                <p className="testnetWarningOverlay__hint">

                    {t("welcome.testnetDismiss")}

                </p>

            </button>

        </div>

    );

}

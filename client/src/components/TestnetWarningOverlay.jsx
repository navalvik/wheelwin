import { useCallback, useEffect, useState } from "react";

import { SHOW_TESTNET_WARNING } from "../config/features";

import "../styles/testnetWarningOverlay.css";

const FADE_MS = 280;

const NETWORK_TITLE = "⚠️ NETWORK NOTICE";
const NETWORK_BODY =
    "THIS PROJECT OPERATES ON TON TESTNET AND TON MAINNET.";
const NETWORK_WALLETS_ONLY =
    "USE THE CORRESPONDING TESTNET OR MAINNET TON WALLET.";
const DISMISS_HINT = "Tap anywhere on this message to continue.";

export default function TestnetWarningOverlay() {

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
                    {NETWORK_TITLE}
                </div>

                <p className="testnetWarningOverlay__body">
                    {NETWORK_BODY}
                </p>

                <p className="testnetWarningOverlay__body">
                    {NETWORK_WALLETS_ONLY}
                </p>

                <p className="testnetWarningOverlay__hint">
                    {DISMISS_HINT}
                </p>

            </button>

        </div>

    );

}

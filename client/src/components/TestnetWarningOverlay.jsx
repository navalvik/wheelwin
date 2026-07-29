import { useCallback, useEffect, useState } from "react";

import { SHOW_TESTNET_WARNING } from "../config/features";

import "../styles/testnetWarningOverlay.css";

const FADE_MS = 280;

/**
 * R6.5 — Page1 Testnet warning overlay.
 * Visible once per page mount when SHOW_TESTNET_WARNING is true.
 * Dismissed by clicking / tapping the warning card.
 */
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

                    ⚠️ TEST MODE

                </div>

                <p className="testnetWarningOverlay__body">

                    THIS PROJECT IS CURRENTLY RUNNING ON THE TON TESTNET.

                </p>

                <p className="testnetWarningOverlay__body">

                    USE TESTNET GRAM (TON) WALLETS ONLY.

                </p>

                <p className="testnetWarningOverlay__hint">

                    Tap anywhere on this message to continue.

                </p>

            </button>

        </div>

    );

}

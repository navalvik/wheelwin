import * as React from "react";
import { useCallback, useState } from "react";

import { SHOW_TESTNET_WARNING } from "../config/features";
import { useLanguage } from "../context/LanguageContext";

import "../styles/networkWarningOverlay.css";

const FADE_MS = 280;

/**
 * R6.5 / restore — Page1 network warning overlay.
 *
 * Standalone informational notice. It depends on nothing but React, the
 * feature flag, and the i18n context: no TON libraries, wallets, smart
 * contracts, payment modules, or deleted financial components are imported.
 *
 * The network is derived from the hostname (same rule as HeaderBar):
 *   - "nine" or "testnet" in the hostname → TESTNET
 *   - anything else → MAINNET
 *
 * A small error boundary wraps the render so that if this component ever
 * throws, Page1 keeps working instead of becoming a blank screen.
 */
function NetworkWarningContent() {

    const { t } = useLanguage();

    // SHOW_TESTNET_WARNING is a module constant, so the initial state below
    // already reflects the flag; no effect synchronization is needed.
    const [visible, setVisible] = useState(SHOW_TESTNET_WARNING);

    const [fading, setFading] = useState(false);

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

    const isTestnet = typeof window !== "undefined" && (
        window.location.hostname.includes("nine") ||
        window.location.hostname.includes("testnet")
    );

    const titleKey = isTestnet ? "welcome.testMode" : "welcome.mainnetMode";
    const bodyKey = isTestnet ? "welcome.testnetBody" : "welcome.mainnetBody";
    const dismissKey = isTestnet
        ? "welcome.testnetDismiss"
        : "welcome.mainnetDismiss";

    return (

        <div
            className={
                fading
                    ? "networkWarningOverlay networkWarningOverlay--fading"
                    : "networkWarningOverlay"
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="network-warning-title"
        >

            <button
                type="button"
                className="networkWarningOverlay__card"
                onClick={dismiss}
            >

                <div
                    id="network-warning-title"
                    className="networkWarningOverlay__eyebrow"
                >

                    {t(titleKey)}

                </div>

                <p className="networkWarningOverlay__body">

                    {t(bodyKey)}

                </p>

                <p className="networkWarningOverlay__hint">

                    {t(dismissKey)}

                </p>

            </button>

        </div>

    );

}

/** Tiny error boundary: a render failure here must never blank Page1. */
class NetworkWarningBoundary extends React.Component {

    constructor(props) {

        super(props);

        this.state = { hasError: false };

    }

    static getDerivedStateFromError() {

        return { hasError: true };

    }

    render() {

        if (this.state.hasError) {

            return null;

        }

        return this.props.children;

    }

}

export default function NetworkWarningOverlay() {

    return (

        <NetworkWarningBoundary>

            <NetworkWarningContent />

        </NetworkWarningBoundary>

    );

}
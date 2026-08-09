import { useRecoveryExperience } from "../context/RecoveryExperienceContext";

import { mapRecoveryStatusMessage } from "../game/sessionRecovery/recoveryFlow";

import "../styles/recoveryOverlay.css";

/**
 * R7.70C20 — Recovery overlay only shows reconnect/restore status.
 * No RETURN LOBBY action after recovery (success or failure).
 * Terminal failures already navigate via RecoveryExperienceContext.
 */
export default function RecoveryOverlay() {

    const { status } = useRecoveryExperience();

    const message = mapRecoveryStatusMessage(status);

    if (!message) {

        return null;

    }

    return (

        <div className="recoveryOverlay" role="status" aria-live="polite">

            <div className="recoveryOverlay__card">

                <p className="recoveryOverlay__message">

                    {message}

                </p>

            </div>

        </div>

    );

}

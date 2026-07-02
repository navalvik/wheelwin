import { useRecoveryExperience } from "../context/RecoveryExperienceContext";

import { RECOVERY_UI_STATUS, mapRecoveryStatusMessage } from "../game/sessionRecovery/recoveryFlow";

import "../styles/recoveryOverlay.css";

export default function RecoveryOverlay() {

    const { status, returnToLobby } = useRecoveryExperience();

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

                {status === RECOVERY_UI_STATUS.FAILED && (

                    <button
                        type="button"
                        className="recoveryOverlay__action"
                        onClick={returnToLobby}
                    >

                        Return to Lobby

                    </button>

                )}

            </div>

        </div>

    );

}

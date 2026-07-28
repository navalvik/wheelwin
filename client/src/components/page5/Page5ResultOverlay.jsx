import { useMemo } from "react";

import { useAuthoritativeSession } from "../../context/AuthoritativeSessionContext";
import { useGameResult } from "../../context/GameResultContext";
import { usePlayerIdentity } from "../../context/PlayerIdentityContext";
import {
    isLocalPlayerWinner,
    resolveAuthoritativeWinnerPlayerId,
    resolvePersonalizedResultPresentation
} from "../../game/result/personalizedResultPresentation";
import { resolveLocalPlayerId } from "../../game/session";

/**
 * R5.18 — Personalized RESULT overlay (local seat vs authoritative winner).
 */
export default function Page5ResultOverlay() {

    const { result } = useGameResult();

    const { identity } = usePlayerIdentity();

    const authoritative = useAuthoritativeSession();

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    const winnerPlayerId = useMemo(
        () => resolveAuthoritativeWinnerPlayerId({ result }),
        [result]
    );

    const presentation = useMemo(
        () => resolvePersonalizedResultPresentation(
            isLocalPlayerWinner(localPlayerId, winnerPlayerId)
        ),
        [localPlayerId, winnerPlayerId]
    );

    if (!result) {

        return null;

    }

    return (

        <div
            className={
                presentation.variant === "win"
                    ? "page5ResultOverlay page5ResultOverlay--win"
                    : presentation.variant === "lost"
                        ? "page5ResultOverlay page5ResultOverlay--lost"
                        : "page5ResultOverlay"
            }
            aria-live="polite"
        >

            {presentation.trophy && (

                <div className="page5ResultOverlay__trophy" aria-hidden="true">
                    {presentation.trophy}
                </div>

            )}

            <div
                className={
                    presentation.variant === "lost"
                        ? "page5ResultOverlay__headline page5ResultOverlay__headline--lost"
                        : "page5ResultOverlay__headline"
                }
            >

                {presentation.headline}

            </div>

        </div>

    );

}

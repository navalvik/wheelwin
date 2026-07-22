import { resolveWheelIcon } from "../game/WheelEngine/wheelUtils";

import { useGameResult } from "../../context/GameResultContext";

/**
 * P5.9 — Page5 RESULT presentation (authoritative winner only).
 * No animations that modify gameplay state. No client timers.
 */
export default function Page5ResultOverlay() {

    const { result } = useGameResult();

    if (!result) {

        return null;

    }

    const winner = result.winner ?? null;

    const sector = result.winningSector ?? null;

    return (

        <div className="page5ResultOverlay" aria-live="polite">

            <div className="page5ResultOverlay__label">
                WINNER
            </div>

            <div
                className="page5ResultOverlay__swatch"
                style={{
                    backgroundColor: winner?.color ?? sector?.color ?? "#888888"
                }}
                aria-hidden="true"
            />

            <div className="page5ResultOverlay__icon">
                {sector?.icon
                    ? resolveWheelIcon(sector.icon)
                    : "—"}
            </div>

            <div className="page5ResultOverlay__meta">
                Sector {Number.isFinite(sector?.index) ? sector.index : "—"}
            </div>

        </div>

    );

}

import { useDeveloperDiagnostics } from "../dev/useDeveloperDiagnostics";

function formatSpeed(value) {

    return `${value.toFixed(1)}°/s`;

}

export default function Page5DevDebugPanel() {

    const {
        gameState,
        physics,
        buttonSnapshot,
        resultOutcome,
        audioStatus,
        socket,
        winner,
        recovery
    } = useDeveloperDiagnostics();

    return (

        <div className="physicsDebugPanel" aria-hidden="true">

            <div className="physicsDebugPanel__title">

                Debug Panel

            </div>

            <div>

                {`Game State: ${gameState}`}

            </div>

            <div>

                {`Button State: ${buttonSnapshot.state}`}

            </div>

            <div>

                {`Press Count: ${buttonSnapshot.pressCount} / 3`}

            </div>

            <div>

                {`Button Enabled: ${buttonSnapshot.enabled ? "yes" : "no"}`}

            </div>

            <div>

                {`Result Preview: ${resultOutcome}`}

            </div>

            <div>

                {`Wheel Angle: ${physics.wheelAngle.toFixed(1)}°`}

            </div>

            <div>

                {`Triangle Angle: ${physics.triangleAngle.toFixed(1)}°`}

            </div>

            <div>

                {`Wheel Speed: ${formatSpeed(physics.wheelSpeed)}`}

            </div>

            <div>

                {`Triangle Speed: ${formatSpeed(physics.triangleSpeed)}`}

            </div>

            <div>

                {`Music: ${audioStatus.musicPlaying ? "playing" : "stopped"}`}

            </div>

            <div>

                {`Playback Rate: ${audioStatus.playbackRate.toFixed(2)}`}

            </div>

            <div>

                {`Audio Unlocked: ${audioStatus.unlocked ? "yes" : "no"}`}

            </div>

            <div>

                {`Loaded Sounds: ${audioStatus.loadedTracks.length}`}

            </div>

            <div className="physicsDebugPanel__title">

                Socket

            </div>

            <div>

                {`Connection: ${socket.connectionState}`}

            </div>

            <div>

                {`Socket ID: ${socket.socketId}`}

            </div>

            <div>

                {`Last In: ${socket.lastIncoming}`}

            </div>

            <div>

                {`Last Out: ${socket.lastOutgoing}`}

            </div>

            <div>

                {`Ping: ${socket.pingMs}`}

            </div>

            <div className="physicsDebugPanel__title">

                Winner

            </div>

            <div>

                {`Resolved: ${winner.resolved}`}

            </div>

            <div>

                {`Winning Sector: ${winner.winningSector}`}

            </div>

            <div>

                {`Winning Player: ${winner.winningPlayer}`}

            </div>

            <div>

                {`Wheel Angle: ${winner.wheelAngle}`}

            </div>

            <div>

                {`Triangle Angle: ${winner.triangleAngle}`}

            </div>

            <div className="physicsDebugPanel__title">

                Recovery

            </div>

            <div>

                {`Connection: ${recovery.connectionState}`}

            </div>

            <div>

                {`Progress: ${recovery.recoveryProgress}`}

            </div>

            <div>

                {`Last Recovery: ${recovery.lastRecoveryTime}`}

            </div>

            <div>

                {`Recovered State: ${recovery.recoveredGameState}`}

            </div>

            <div>

                {`Message: ${recovery.recoveryMessage}`}

            </div>

            <div className="physicsDebugPanel__hint">

                {`Sectors 3–6 | States ]/→ | Result w/l | Ping p | `
                    + `Loss Shift+O | Recover Shift+R | `
                    + `P offline Shift+1-3 | P1 Alt+r/s/b/v/x/d`}

            </div>

        </div>

    );

}

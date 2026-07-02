import { useSyncExternalStore } from "react";

import { getPlayerIconGlyph } from "../../game/playerUI";
import { PLAYER_UI_STATES } from "../../game/playerUI/PlayerState";
import { useDeveloperDiagnostics } from "./useDeveloperDiagnostics";

const PLAYER_COLORS = Object.freeze({
    1: "#1c73d0",
    2: "#00aa44",
    3: "#e67e00"
});

function formatSpeed(value) {

    return `${value.toFixed(1)}°/s`;

}

function DashboardSection({ title, children, className = "" }) {

    return (

        <section className={`devDashboard__section ${className}`.trim()}>

            <h2 className="devDashboard__sectionTitle">

                {title}

            </h2>

            <div className="devDashboard__sectionBody">

                {children}

            </div>

        </section>

    );

}

function MetricRow({ label, value }) {

    return (

        <div className="devDashboard__row">

            <span className="devDashboard__label">

                {label}

            </span>

            <span className="devDashboard__value">

                {value}

            </span>

        </div>

    );

}

function DashboardPlayerCard({ playerId, engine, winningPlayerId }) {

    const player = useSyncExternalStore(
        (onStoreChange) => engine.subscribePlayerChanges(
            playerId,
            onStoreChange
        ),
        () => engine.getPlayer(playerId),
        () => engine.getPlayer(playerId)
    );

    if (!player) {

        return (

            <div className="devDashboard__playerCard">

                <div className="devDashboard__playerTitle">

                    {`Player ${playerId}`}

                </div>

                <MetricRow label="Status" value="Not loaded" />

            </div>

        );

    }

    const isWinner = winningPlayerId === player.id
        && player.state === PLAYER_UI_STATES.WIN;

    return (

        <div className="devDashboard__playerCard">

            <div className="devDashboard__playerTitle">

                {`Player ${player.id}`}

            </div>

            <MetricRow label="Nickname" value={player.nickname} />

            <MetricRow
                label="Icon"
                value={`${player.icon} (${getPlayerIconGlyph(player.icon)})`}
            />

            <MetricRow
                label="Color"
                value={(
                    <span
                        className="devDashboard__colorSwatch"
                        style={{ backgroundColor: PLAYER_COLORS[player.id] }}
                    />
                )}
            />

            <MetricRow
                label="Online"
                value={player.online ? "Online" : "Offline"}
            />

            <MetricRow label="State" value={player.state} />

            <MetricRow label="Activity" value={player.activityState} />

            <MetricRow label="Remaining Presses" value="—" />

            <MetricRow
                label="Winner"
                value={isWinner ? "Yes" : "No"}
            />

        </div>

    );

}

function PlaceholderModule({ label }) {

    return (

        <p className="devDashboard__placeholder">

            {`${label} — module slot reserved for future diagnostics.`}

        </p>

    );

}

export default function DeveloperDashboardSections({
    wheelSectorCount
}) {

    const {
        gameState,
        physics,
        buttonSnapshot,
        resultOutcome,
        audioStatus,
        socket,
        socketStatus,
        winner,
        winnerSnapshot,
        recovery,
        playerEngine
    } = useDeveloperDiagnostics();

    const winningPlayerId = winnerSnapshot.winningPlayer?.id ?? null;

    const lastSocketEvent = socketStatus.lastIncoming?.type
        || socketStatus.lastOutgoing?.type
        || "—";

    return (

        <div className="devDashboard__grid">

            <DashboardSection title="System" className="devDashboard__section--system">

                <MetricRow
                    label="Health"
                    value={socketStatus.connected ? "Client OK" : "Disconnected"}
                />

                <MetricRow label="Metrics" value="Local client metrics" />

                <PlaceholderModule label="Metrics timeline" />

                <MetricRow
                    label="Environment"
                    value={import.meta.env.MODE}
                />

                <MetricRow
                    label="Build"
                    value={`Vite ${import.meta.env.DEV ? "development" : "production"}`}
                />

            </DashboardSection>

            <DashboardSection title="Network" className="devDashboard__section--network">

                <MetricRow label="Socket" value={socket.connectionState} />

                <MetricRow label="Socket ID" value={socket.socketId} />

                <MetricRow label="Ping" value={socket.pingMs} />

                <MetricRow
                    label="Reconnect"
                    value={socketStatus.connected ? "Connected" : "Awaiting reconnect"}
                />

                <MetricRow label="Last In" value={socket.lastIncoming} />

                <MetricRow label="Last Out" value={socket.lastOutgoing} />

            </DashboardSection>

            <DashboardSection title="Game" className="devDashboard__section--game">

                <MetricRow label="Game State" value={gameState} />

                <MetricRow
                    label="Configuration"
                    value={`${wheelSectorCount} sectors`}
                />

                <MetricRow label="Game Clock" value={gameState} />

                <MetricRow label="Timers" value="Synced via game state" />

                <PlaceholderModule label="Configuration engine detail" />

            </DashboardSection>

            <DashboardSection title="Physics" className="devDashboard__section--physics">

                <MetricRow
                    label="Wheel Angle"
                    value={`${physics.wheelAngle.toFixed(1)}°`}
                />

                <MetricRow
                    label="Triangle Angle"
                    value={`${physics.triangleAngle.toFixed(1)}°`}
                />

                <MetricRow
                    label="Wheel Speed"
                    value={formatSpeed(physics.wheelSpeed)}
                />

                <MetricRow
                    label="Triangle Speed"
                    value={formatSpeed(physics.triangleSpeed)}
                />

                <MetricRow
                    label="Brake"
                    value={physics.isBraking ? "Active" : "Inactive"}
                />

                <MetricRow
                    label="Elapsed"
                    value={`${physics.elapsedTime.toFixed(2)}s`}
                />

            </DashboardSection>

            <DashboardSection title="Input" className="devDashboard__section--input">

                <MetricRow label="Button State" value={buttonSnapshot.state} />

                <MetricRow
                    label="Press Counter"
                    value={`${buttonSnapshot.pressCount} / 3`}
                />

                <MetricRow
                    label="Remaining Presses"
                    value={`${Math.max(0, 3 - buttonSnapshot.pressCount)}`}
                />

                <MetricRow
                    label="Button Enabled"
                    value={buttonSnapshot.enabled ? "Yes" : "No"}
                />

                <MetricRow label="Result Preview" value={resultOutcome} />

                <MetricRow label="Cooldowns" value="Engine-managed" />

            </DashboardSection>

            <DashboardSection
                title="Players"
                className="devDashboard__section--players devDashboard__section--wide"
            >

                <div className="devDashboard__playerGrid">

                    <DashboardPlayerCard
                        playerId={1}
                        engine={playerEngine}
                        winningPlayerId={winningPlayerId}
                    />

                    <DashboardPlayerCard
                        playerId={2}
                        engine={playerEngine}
                        winningPlayerId={winningPlayerId}
                    />

                    <DashboardPlayerCard
                        playerId={3}
                        engine={playerEngine}
                        winningPlayerId={winningPlayerId}
                    />

                </div>

            </DashboardSection>

            <DashboardSection title="Result" className="devDashboard__section--result">

                <MetricRow label="Resolved" value={winner.resolved} />

                <MetricRow label="Winning Sector" value={winner.winningSector} />

                <MetricRow label="Winning Player" value={winner.winningPlayer} />

                <MetricRow label="Wheel Angle" value={winner.wheelAngle} />

                <MetricRow label="Triangle Angle" value={winner.triangleAngle} />

            </DashboardSection>

            <DashboardSection title="Payment" className="devDashboard__section--payment">

                <PlaceholderModule label="Payment engine" />

                <MetricRow label="Platform Fee" value="—" />

                <MetricRow label="Prize" value="—" />

                <MetricRow label="Payment Status" value="—" />

                <MetricRow label="Transaction ID" value="—" />

            </DashboardSection>

            <DashboardSection title="Recovery" className="devDashboard__section--recovery">

                <MetricRow label="Connection" value={recovery.connectionState} />

                <MetricRow label="Snapshot Status" value={recovery.recoveryProgress} />

                <MetricRow label="Reconnect Progress" value={recovery.recoveryProgress} />

                <MetricRow label="Last Recovery" value={recovery.lastRecoveryTime} />

                <MetricRow label="Recovered State" value={recovery.recoveredGameState} />

                <MetricRow label="Message" value={recovery.recoveryMessage} />

            </DashboardSection>

            <DashboardSection title="Audit" className="devDashboard__section--audit">

                <PlaceholderModule label="Audit engine" />

                <MetricRow label="Last Audit" value="—" />

                <MetricRow label="Verification" value="—" />

            </DashboardSection>

            <DashboardSection
                title="Event Bus"
                className="devDashboard__section--events devDashboard__section--wide"
            >

                <MetricRow label="Recent Events" value={lastSocketEvent} />

                <MetricRow
                    label="Event Count"
                    value="Socket stream (live)"
                />

                <MetricRow label="Last Event" value={lastSocketEvent} />

                <MetricRow label="Live Updates" value="Active via contexts" />

                <PlaceholderModule label="Event monitor timeline" />

            </DashboardSection>

            <DashboardSection
                title="Audio"
                className="devDashboard__section--audio"
            >

                <MetricRow
                    label="Music"
                    value={audioStatus.musicPlaying ? "Playing" : "Stopped"}
                />

                <MetricRow
                    label="Playback Rate"
                    value={audioStatus.playbackRate.toFixed(2)}
                />

                <MetricRow
                    label="Unlocked"
                    value={audioStatus.unlocked ? "Yes" : "No"}
                />

                <MetricRow
                    label="Loaded Sounds"
                    value={audioStatus.loadedTracks.length}
                />

            </DashboardSection>

        </div>

    );

}

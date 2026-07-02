import { useAudio } from "../../context/AudioContext";
import { useCentralButton } from "../../context/CentralButtonContext";
import { useGameState } from "../../context/GameStateContext";
import { usePhysicsDiscreteSnapshot } from "../../context/PhysicsContext";
import { usePlayerUI } from "../../context/PlayerUIContext";
import {
    formatRecoveryDebugLines,
    useSessionRecoveryDebug
} from "../../context/SessionRecoveryContext";
import {
    formatSocketDebugLines,
    useSocketDebugStatus
} from "../../context/SocketSyncContext";
import {
    formatWinnerDebugLines,
    useWinnerDebugSnapshot
} from "../../context/WinnerResolverContext";

export function useDeveloperDiagnostics() {

    const { gameState } = useGameState();

    const physics = usePhysicsDiscreteSnapshot();

    const {
        snapshot: buttonSnapshot,
        setDebugResultOutcome,
        resultOutcome
    } = useCentralButton();

    const {
        engine: playerEngine,
        togglePlayerOnline,
        setDebugPlayerState
    } = usePlayerUI();

    const { status: audioStatus } = useAudio();

    const socketStatus = useSocketDebugStatus();

    const winnerSnapshot = useWinnerDebugSnapshot();

    const recoveryStatus = useSessionRecoveryDebug();

    return {
        gameState,
        physics,
        buttonSnapshot,
        resultOutcome,
        audioStatus,
        socketStatus,
        socket: formatSocketDebugLines(socketStatus),
        winnerSnapshot,
        winner: formatWinnerDebugLines(winnerSnapshot),
        recoveryStatus,
        recovery: formatRecoveryDebugLines(recoveryStatus),
        playerEngine,
        setDebugResultOutcome,
        togglePlayerOnline,
        setDebugPlayerState
    };

}

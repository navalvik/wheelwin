import { GAME_STATES } from "../../game/GameState";

import PlayerPanel from "./PlayerPanel";
import ReadyPlayerPanel from "./ReadyPlayerPanel";

import { useGameState } from "../../context/GameStateContext";

export default function Page5PlayerPanel() {

    const { gameState } = useGameState();

    if (gameState === GAME_STATES.READY
        || gameState === GAME_STATES.SELF_TEST) {

        return <ReadyPlayerPanel />;

    }

    return <PlayerPanel />;

}

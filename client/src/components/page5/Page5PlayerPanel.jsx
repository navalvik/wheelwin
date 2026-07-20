import { GAME_STATES } from "../GameState";

import PlayerPanel from "./PlayerPanel";
import ReadyPlayerPanel from "./ReadyPlayerPanel";

import { useGameState } from "../../context/GameStateContext";

export default function Page5PlayerPanel() {

    const { gameState } = useGameState();

    if (gameState === GAME_STATES.READY) {

        return <ReadyPlayerPanel />;

    }

    return <PlayerPanel />;

}

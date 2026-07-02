import PlayerPanelView from "../game/PlayerUI/PlayerPanelView";

import { usePlayerUI } from "../../context/PlayerUIContext";

export default function PlayerPanel() {

    const { engine } = usePlayerUI();

    return <PlayerPanelView engine={engine} />;

}

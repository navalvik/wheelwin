import { DEV_VERIFY_PLAYERS } from "../../utils/gameSession";

import { resolveWheelIcon } from "../../components/game/WheelEngine/wheelUtils";

import {
    PLAYER_COUNT,
    PLAYER_UI_STATES,
    createDefaultPlayerRecord,
    isValidPlayerUIState,
    mapGameStateToPlayerUIState
} from "./PlayerState";

const ICON_KEY_BY_PLAYER = Object.freeze({
    1: "dice",
    2: "spade",
    3: "queen"
});

export const DEFAULT_PLAYER_UI_DATA = Object.freeze(
    DEV_VERIFY_PLAYERS.slice(0, PLAYER_COUNT).map((player) => (
        createDefaultPlayerRecord({
            id: player.id,
            nickname: player.nickname,
            icon: ICON_KEY_BY_PLAYER[player.id] || "dice",
            online: true,
            state: PLAYER_UI_STATES.READY
        })
    ))
);

export function getPlayerIconGlyph(iconKey) {

    return resolveWheelIcon(iconKey);

}

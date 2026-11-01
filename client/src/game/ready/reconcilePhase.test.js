import assert from "node:assert/strict";
import { GAME_STATES } from "../GameState.js";
import { serverPhaseRank, canAdvanceFromServerClock } from "./reconcilePhase.js";

const game = "gZde-game";
const payload = phase => ({gameId:game,phase});
assert.equal(serverPhaseRank(GAME_STATES.PRE_GAME_READY),0);
assert.equal(serverPhaseRank(GAME_STATES.READY),1);
assert.equal(serverPhaseRank(GAME_STATES.RESULT),5);
assert.equal(canAdvanceFromServerClock(payload("PRE_GAME_READY"),{gameId:game,phaseRank:null}),true);
assert.equal(canAdvanceFromServerClock(payload("PRE_GAME_READY"),{gameId:game,phaseRank:0}),false);
assert.equal(canAdvanceFromServerClock(payload("PRE_GAME_READY"),{gameId:game,phaseRank:1}),false);
assert.equal(canAdvanceFromServerClock(payload("READY"),{gameId:game,phaseRank:0}),true);
assert.equal(canAdvanceFromServerClock(payload("BRAKE"),{gameId:game,phaseRank:3}),true);
assert.equal(canAdvanceFromServerClock(payload("RESULT"),{gameId:game,phaseRank:5}),false);
assert.equal(canAdvanceFromServerClock(payload("BRAKE"),{gameId:"another",phaseRank:0}),false);
assert.equal(canAdvanceFromServerClock({phase:"PRE_GAME_READY"},{gameId:game,phaseRank:null}),false);
assert.equal(canAdvanceFromServerClock(payload("bogus"),{gameId:game,phaseRank:null}),false);
console.log("reconcilePhase: all assertions passed");

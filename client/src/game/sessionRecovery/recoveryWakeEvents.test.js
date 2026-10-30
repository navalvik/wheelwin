import { subscribeRecoveryWakeEvents } from "./recoveryWakeEvents.js";
import { applyRecoveryRequestPresentation } from "./recoveryReconnectPolicy.js";
import { RECOVERY_UI_STATUS } from "./recoveryFlow.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function target() {
    const listeners = new Map();
    return {
        visibilityState: "visible",
        addEventListener(name, handler) {
            const set = listeners.get(name) ?? new Set();
            set.add(handler);
            listeners.set(name, set);
        },
        removeEventListener(name, handler) {
            listeners.get(name)?.delete(handler);
        },
        dispatch(name) {
            for (const handler of listeners.get(name) ?? []) handler();
        }
    };
}

const documentTarget = target();
const windowTarget = target();
let socketConnected = true;
let hadDisconnect = false;
let inFlight = false;
let status = RECOVERY_UI_STATUS.IDLE;
let requests = 0;

const requestSessionRecovery = () => {
    if (inFlight) return;
    inFlight = true;
    requests += 1;
    applyRecoveryRequestPresentation({
        socketConnected,
        hadDisconnect,
        reconnectingStatus: RECOVERY_UI_STATUS.RECONNECTING,
        setStatus: nextStatus => { status = nextStatus; }
    });
};

const unsubscribe = subscribeRecoveryWakeEvents({
    documentTarget,
    windowTarget,
    isEligible: () => true,
    onWake: requestSessionRecovery
});

documentTarget.dispatch("visibilitychange");
windowTarget.dispatch("pageshow");
assert(requests === 1, "visibilitychange and pageshow do not overlap recovery");
assert(status === RECOVERY_UI_STATUS.IDLE,
    "healthy wallet return requests sync without a blocking overlay");

inFlight = false;
hadDisconnect = true;
socketConnected = true;
windowTarget.dispatch("pageshow");
assert(requests === 2, "return after a real disconnect requests authenticated recovery");
assert(status === RECOVERY_UI_STATUS.RECONNECTING,
    "real disconnect keeps the short-lived reconnect overlay visible");

documentTarget.visibilityState = "hidden";
documentTarget.dispatch("visibilitychange");
assert(requests === 2, "hidden visibility event does not start recovery");

unsubscribe();
inFlight = false;
windowTarget.dispatch("pageshow");
assert(requests === 2, "unmounted wake listeners are removed");

console.log("recoveryWakeEvents.test.js: all assertions passed");

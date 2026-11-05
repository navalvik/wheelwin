import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GAME_STATES } from "../../../game/GameState.js";
import { CentralButtonEngine } from "../../../game/centralButton/CentralButtonEngine.js";
import { BUTTON_STATES } from "../../../game/centralButton/ButtonState.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(testDirectory, "../../../../");
const vite = await createServer({
    root: clientRoot,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error"
});

try {
    const [
        { default: CentralButtonView },
        { LanguageProvider }
    ] = await Promise.all([
        vite.ssrLoadModule(resolve(
            clientRoot,
            "src/components/game/CentralButton/CentralButtonView.jsx"
        )),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/LanguageContext.jsx"))
    ]);

    function captureButtonHandlers(props) {
        let buttonElement;

        function CaptureButton() {
            buttonElement = CentralButtonView.type(props);
            return buttonElement;
        }

        renderToString(createElement(
            LanguageProvider,
            null,
            createElement(CaptureButton)
        ));

        return buttonElement.props;
    }

    const engine = new CentralButtonEngine();
    engine.syncWithGameState(GAME_STATES.PRE_GAME_READY);
    const preReadySnapshot = engine.getSnapshot();
    assert.equal(preReadySnapshot.presentation.state, BUTTON_STATES.PRE_GAME_READY);
    assert.equal(preReadySnapshot.presentation.enabled, true);

    const readyEvents = [];
    engine.onEvent((event) => readyEvents.push(event));
    const preReadyHandlers = captureButtonHandlers({
        snapshot: preReadySnapshot,
        onPress: () => engine.confirmPreGameReady(),
        onRelease: undefined
    });

    assert.doesNotThrow(() => preReadyHandlers.onPointerLeave({ buttons: 0 }));
    let prevented = false;
    preReadyHandlers.onPointerDown({
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true, "READY press prevents the browser default action");
    assert.deepEqual(readyEvents.map(({ type }) => type), ["preGameReadyConfirm"]);

    let releaseCount = 0;
    const releaseHandlers = captureButtonHandlers({
        snapshot: preReadySnapshot,
        onPress() {},
        onRelease() { releaseCount += 1; }
    });
    releaseHandlers.onPointerLeave({ buttons: 1 });
    assert.equal(releaseCount, 0, "pointer leave while pressed does not release");
    releaseHandlers.onPointerLeave({ buttons: 0 });
    assert.equal(releaseCount, 1, "pointer leave releases when onRelease exists");

    engine.syncWithGameState(GAME_STATES.READY);
    assert.equal(engine.getSnapshot().presentation.state, BUTTON_STATES.READY);
    assert.equal(
        captureButtonHandlers({
            snapshot: engine.getSnapshot(),
            onPress() {},
            onRelease() {}
        }).disabled,
        true,
        "the existing READY phase presentation remains non-interactive"
    );
} finally {
    await vite.close();
}

process.stdout.write("CentralButtonView.test.js: all assertions passed\n");

import DeveloperConsole from "../console/DeveloperConsole";

import "../styles/developerConsole.css";

/**
 * R6.0B — Route entry for the WheelWin Developer Console.
 *
 * Browser path remains `/debug` for compatibility.
 * This page is not part of gameplay and does not mount GameEngineProviders.
 */
export default function PageDeveloperConsole() {

    return <DeveloperConsole />;

}

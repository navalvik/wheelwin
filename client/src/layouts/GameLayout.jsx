import { useContext } from "react";

import Banner from "../components/Banner";
import HeaderBar from "../components/HeaderBar";
import InfoBar from "../components/InfoBar";

import { DevNavigationContext } from "../context/DevNavigationContext";
import { GameSessionContext } from "../context/GameSessionContext";

export default function GameLayout({

    message,

    messageClassName = "",

    nextEnabled = false,

    showNextButton = true,

    nextLabel = "NEXT",

    backEnabled = false,

    onBack,

    onNext,

    /** When false, hides JUMP even in DEV_MODE (e.g. Page6 FINISH). */
    showJumpButton,

    children

}) {

    const devNavigation = useContext(DevNavigationContext);

    const gameSession = useContext(GameSessionContext);

    const showInfoBar = gameSession?.showInfoBar ?? false;

    const jumpVisible = showJumpButton === false
        ? false
        : Boolean(devNavigation?.enabled);

    return (

        <div className={`gameLayout${showInfoBar ? " gameLayout--withInfoBar" : ""}`}>

            <Banner />

            <HeaderBar
              message={message}
              messageClassName={messageClassName}
              nextEnabled={nextEnabled}
              showNextButton={showNextButton}
              nextLabel={nextLabel}
              backEnabled={backEnabled}
              onBack={onBack}
              onNext={onNext}
              showJumpButton={jumpVisible}
              onJump={devNavigation?.onJump}
            />

            <div className="contentArea">

                {children}

            </div>

            {showInfoBar && <InfoBar />}

        </div>

    );

}

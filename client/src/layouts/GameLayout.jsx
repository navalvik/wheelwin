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

    backEnabled = false,

    onBack,

    onNext,

    children

}) {

    const devNavigation = useContext(DevNavigationContext);

    const gameSession = useContext(GameSessionContext);

    const showInfoBar = gameSession?.showInfoBar ?? false;

    return (

        <div className={`gameLayout${showInfoBar ? " gameLayout--withInfoBar" : ""}`}>

            <Banner />

            <HeaderBar
              message={message}
              messageClassName={messageClassName}
              nextEnabled={nextEnabled}
              showNextButton={showNextButton}
              backEnabled={backEnabled}
              onBack={onBack}
              onNext={onNext}
              showJumpButton={devNavigation?.enabled}
              onJump={devNavigation?.onJump}
            />

            <div className="contentArea">

                {children}

            </div>

            {showInfoBar && <InfoBar />}

        </div>

    );

}

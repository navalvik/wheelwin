import { useContext } from "react";

import AdvertisementSlot from "../ads/AdvertisementSlot";
import HeaderBar from "../components/HeaderBar";
import InfoBar from "../components/InfoBar";

import { DevNavigationContext } from "../context/DevNavigationContext";
import { GameSessionContext } from "../context/GameSessionContext";
import { DEBUG_JUMP_ENABLED } from "../config/devMode";

export default function GameLayout({

    message,

    messageClassName = "",

    nextEnabled = false,

    showNextButton = true,

    nextLabel,

    backEnabled = false,

    onBack,

    onNext,

    /** When false, hides JUMP even when DEBUG_JUMP_ENABLED (e.g. Page6 FINISH). */
    showJumpButton,

    children

}) {

    const devNavigation = useContext(DevNavigationContext);

    const gameSession = useContext(GameSessionContext);

    const showInfoBar = gameSession?.showInfoBar ?? false;

    const jumpVisible = DEBUG_JUMP_ENABLED
        && showJumpButton !== false
        && Boolean(devNavigation?.enabled);

    return (

        <div className={`gameLayout${showInfoBar ? " gameLayout--withInfoBar" : ""}`}>

            <AdvertisementSlot />

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

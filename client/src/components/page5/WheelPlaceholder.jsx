import { memo } from "react";

import WheelEngine from "../game/WheelEngine/WheelEngine";
import TriangleEngine from "../game/TriangleEngine/TriangleEngine";

import { usePhysics } from "../../context/PhysicsContext";

import CenterButton from "./CenterButton";

const CenterButtonLayer = memo(function CenterButtonLayer({
    buttonSnapshot,
    onPress,
    onRelease
}) {

    return (

        <div className="wheelCenterButtonLayer">

            <CenterButton
                snapshot={buttonSnapshot}
                onPress={onPress}
                onRelease={onRelease}
            />

        </div>

    );

});

function WheelPlaceholder({

    wheelConfiguration,

    buttonSnapshot,

    onButtonPress,

    onButtonRelease

}) {

    const { subscribeFrame, getFrame } = usePhysics();

    return (

        <div className="wheelPlaceholder">

            <div className="wheelEngineLayer">

                <WheelEngine
                    configuration={wheelConfiguration}
                    subscribeFrame={subscribeFrame}
                    getFrame={getFrame}
                />

            </div>

            <CenterButtonLayer
                buttonSnapshot={buttonSnapshot}
                onPress={onButtonPress}
                onRelease={onButtonRelease}
            />

            <div className="wheelTriangleLayer">

                <TriangleEngine
                    subscribeFrame={subscribeFrame}
                    getFrame={getFrame}
                />

            </div>

        </div>

    );

}

export default memo(WheelPlaceholder);

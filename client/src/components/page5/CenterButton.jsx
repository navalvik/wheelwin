import CentralButtonView from "../game/CentralButton/CentralButtonView";

export default function CenterButton({ snapshot, onPress, onRelease }) {

    return (

        <CentralButtonView
            snapshot={snapshot}
            onPress={onPress}
            onRelease={onRelease}
        />

    );

}

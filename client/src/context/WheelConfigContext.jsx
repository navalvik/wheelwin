import {
    createContext,
    useContext,
    useMemo,
    useState
} from "react";

import {
    DEFAULT_WHEEL_SECTOR_COUNT,
    getWheelDebugConfig
} from "../components/game/WheelEngine";

import { useRegisterEngineModule } from "./EngineBridgeContext";

const WheelConfigContext = createContext(null);

function resolveWheelConfig(payload) {

    if (!payload) {

        return null;

    }

    if (payload.sectors) {

        return {
            sectors: payload.sectors,
            wheelAngle: Number.isFinite(payload.wheelAngle)
                ? payload.wheelAngle
                : null,
            triangleAngle: Number.isFinite(payload.triangleAngle)
                ? payload.triangleAngle
                : null
        };

    }

    if (payload.sectorCount) {

        return getWheelDebugConfig(payload.sectorCount);

    }

    return null;

}

export function WheelConfigProvider({ children }) {

    const [wheelConfiguration, setWheelConfiguration] = useState(
        () => getWheelDebugConfig(DEFAULT_WHEEL_SECTOR_COUNT)
    );

    // The wheel presentation config is server-driven (WHEEL_CONFIGURATION) and
    // restored during recovery. Registering the module here — above Page5 —
    // keeps the subscription alive for the whole gameplay session so no
    // authoritative wheel configuration is missed because of page mounting.
    useRegisterEngineModule("wheel", () => ({

        setConfiguration: (payload) => {

            const next = resolveWheelConfig(payload);

            if (next) {

                setWheelConfiguration(next);

            }

        },

        restoreWheel: (snapshot) => {

            const next = resolveWheelConfig(snapshot?.wheelConfiguration);

            if (next) {

                setWheelConfiguration(next);

            }

        }

    }));

    const value = useMemo(() => ({
        wheelConfiguration,
        setWheelConfiguration
    }), [wheelConfiguration]);

    return (

        <WheelConfigContext.Provider value={value}>

            {children}

        </WheelConfigContext.Provider>

    );

}

export function useWheelConfig() {

    const context = useContext(WheelConfigContext);

    if (!context) {

        throw new Error(
            "useWheelConfig must be used within WheelConfigProvider"
        );

    }

    return context;

}

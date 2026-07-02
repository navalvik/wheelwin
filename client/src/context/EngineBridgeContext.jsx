import {
    createContext,
    useContext,
    useEffect,
    useRef
} from "react";

import { EngineBridge } from "../socket/EngineBridge";

const EngineBridgeContext = createContext(null);

export function EngineBridgeProvider({ children }) {

    const bridgeRef = useRef(null);

    if (!bridgeRef.current) {

        bridgeRef.current = new EngineBridge();

    }

    return (

        <EngineBridgeContext.Provider value={bridgeRef.current}>

            {children}

        </EngineBridgeContext.Provider>

    );

}

export function useEngineBridge() {

    const context = useContext(EngineBridgeContext);

    if (!context) {

        throw new Error(
            "useEngineBridge must be used within EngineBridgeProvider"
        );

    }

    return context;

}

export function useRegisterEngineModule(moduleName, createApi) {

    const bridge = useEngineBridge();

    const createApiRef = useRef(createApi);

    createApiRef.current = createApi;

    useEffect(() => {

        const api = createApiRef.current();

        if (!api) {

            return undefined;

        }

        return bridge.register(moduleName, api);

    }, [bridge, moduleName]);

}

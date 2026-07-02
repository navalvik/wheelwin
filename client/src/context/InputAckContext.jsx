import {
    createContext,
    useContext,
    useMemo,
    useState
} from "react";

import { DEV_MODE } from "../config/devMode";

import { useRegisterEngineModule } from "./EngineBridgeContext";

const InputAckContext = createContext(null);

export function InputAckProvider({ children }) {

    const [lastAck, setLastAck] = useState(null);

    useRegisterEngineModule("inputAck", () => ({

        onInputAccepted: (payload) => {

            setLastAck({
                status: "accepted",
                label: "Input Accepted",
                ...payload
            });

            if (DEV_MODE) {

                console.debug("[InputSync] Input Accepted", payload);

            }

        },

        onInputRejected: (payload) => {

            setLastAck({
                status: "rejected",
                label: "Input Rejected",
                ...payload
            });

            if (DEV_MODE) {

                console.debug("[InputSync] Input Rejected", payload);

            }

        }

    }));

    const value = useMemo(() => ({
        lastAck
    }), [lastAck]);

    return (

        <InputAckContext.Provider value={value}>

            {children}

        </InputAckContext.Provider>

    );

}

export function useInputAck() {

    const context = useContext(InputAckContext);

    if (!context) {

        throw new Error(
            "useInputAck must be used within InputAckProvider"
        );

    }

    return context;

}

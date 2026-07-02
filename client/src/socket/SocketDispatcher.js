import { INCOMING_SOCKET_EVENTS } from "./socketEvents";

export class SocketDispatcher {

    constructor({ onUnknownEvent, devMode = false } = {}) {

        this._routes = new Map();

        this._onUnknownEvent = onUnknownEvent;

        this._devMode = devMode;

        this._registerDefaultRoutes();

    }

    register(eventType, handler) {

        if (!eventType || typeof handler !== "function") {

            return () => {};

        }

        const handlers = this._routes.get(eventType) || [];

        handlers.push(handler);

        this._routes.set(eventType, handlers);

        return () => {

            const currentHandlers = this._routes.get(eventType) || [];

            this._routes.set(
                eventType,
                currentHandlers.filter((entry) => entry !== handler)
            );

        };

    }

    registerModuleHandlers(moduleHandlers = {}) {

        const unregisterFns = Object.entries(moduleHandlers).map(
            ([eventType, handler]) => this.register(eventType, handler)
        );

        return () => {

            unregisterFns.forEach((unregister) => unregister());

        };

    }

    dispatch(message) {

        const normalized = normalizeSocketMessage(message);

        if (!normalized) {

            return null;

        }

        const handlers = this._routes.get(normalized.type) || [];

        if (handlers.length === 0) {

            if (this._devMode) {

                this._onUnknownEvent?.(normalized);

            }

            return normalized;

        }

        handlers.forEach((handler) => {

            try {

                handler(normalized.payload, normalized);

            } catch (error) {

                console.warn(
                    `[SocketDispatcher] Handler failed for ${normalized.type}`,
                    error
                );

            }

        });

        return normalized;

    }

    _registerDefaultRoutes() {

        Object.values(INCOMING_SOCKET_EVENTS).forEach((eventType) => {

            if (!this._routes.has(eventType)) {

                this._routes.set(eventType, []);

            }

        });

    }

}

export function normalizeSocketMessage(message) {

    if (!message || typeof message !== "object") {

        return null;

    }

    const type = message.type;

    if (typeof type !== "string" || !type.trim()) {

        return null;

    }

    return {
        type: type.trim().toUpperCase(),
        payload: message.payload ?? {}
    };

}

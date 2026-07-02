export class LifecycleError extends Error {

    constructor({ phase, component, reason, cause = null }) {

        super(`[${phase}] ${component}: ${reason}`);

        this.name = "LifecycleError";

        this.phase = phase;

        this.component = component;

        this.reason = reason;

        this.cause = cause;

    }

}

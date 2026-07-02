export function deepFreezeAudit(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreezeAudit(value[key]);

    }

    return value;

}

export function deepFreezePayment(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreezePayment(value[key]);

    }

    return value;

}

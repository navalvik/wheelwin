import { randomUUID } from "node:crypto";

export function createEventId() {

    return `evt_${randomUUID()}`;

}

export function createTraceId() {

    return `trace_${randomUUID()}`;

}

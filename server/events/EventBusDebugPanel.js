export function printEventBusDebugPanel({ logger, eventBus }) {

    const snapshot = eventBus.getDebugSnapshot();

    logger.info("[EventBus Debug]");
    logger.info("");

    if (snapshot.registeredEvents.length === 0) {

        logger.info("Registered Events: none");

    } else {

        logger.info("Registered Events:");

        for (const entry of snapshot.registeredEvents) {

            logger.info(
                `  ${entry.event} (${entry.subscriberCount} subscriber${
                    entry.subscriberCount === 1 ? "" : "s"
                })`
            );

        }

    }

    logger.info("");
    logger.info(`Last Event ID: ${snapshot.lastEventId ?? "none"}`);
    logger.info(`Last Trace ID: ${snapshot.lastTraceId ?? "none"}`);
    logger.info(`Last Source: ${snapshot.lastSource ?? "none"}`);
    logger.info(`Last Type: ${snapshot.lastType ?? "none"}`);
    logger.info(
        `Timestamp: ${
            snapshot.lastTimestamp !== null
                ? new Date(snapshot.lastTimestamp).toISOString()
                : "none"
        }`
    );
    logger.info(`Subscriber Count: ${snapshot.lastSubscriberCount}`);
    logger.info("");

}

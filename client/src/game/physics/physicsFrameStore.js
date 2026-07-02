export function createPhysicsFrameStore() {

    const frame = {
        wheelAngle: 0,
        triangleAngle: 0,
        wheelSpeed: 0,
        triangleSpeed: 0,
        elapsedTime: 0,
        isBraking: false
    };

    const frameListeners = new Set();

    const discreteListeners = new Set();

    return {

        frame,

        getFrame() {

            return frame;

        },

        publishFrame(engine) {

            engine.writeSnapshot(frame);

            frameListeners.forEach((listener) => listener());

        },

        publishDiscrete(engine) {

            engine.writeSnapshot(frame);

            discreteListeners.forEach((listener) => listener());

        },

        subscribeFrame(listener) {

            frameListeners.add(listener);

            return () => {

                frameListeners.delete(listener);

            };

        },

        subscribeDiscrete(listener) {

            discreteListeners.add(listener);

            return () => {

                discreteListeners.delete(listener);

            };

        }

    };

}

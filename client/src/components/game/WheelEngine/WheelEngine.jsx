import { useEffect, useRef } from "react";

import { WheelEngine as WheelEngineCore } from "./WheelRenderer";

import "./wheelEngine.css";

export default function WheelEngine({
    configuration,
    subscribeFrame,
    getFrame
}) {

    const containerRef = useRef(null);

    const canvasRef = useRef(null);

    const engineRef = useRef(null);

    const getFrameRef = useRef(getFrame);

    getFrameRef.current = getFrame;

    useEffect(() => {

        if (!canvasRef.current) {

            return undefined;

        }

        engineRef.current = new WheelEngineCore(canvasRef.current);

        return () => {

            engineRef.current = null;

        };

    }, []);

    useEffect(() => {

        if (!engineRef.current || !configuration) {

            return;

        }

        engineRef.current.setConfiguration(configuration);

        engineRef.current.render();

    }, [configuration]);

    useEffect(() => {

        if (!engineRef.current || !subscribeFrame) {

            return undefined;

        }

        return subscribeFrame(() => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            engine.setAngle(getFrameRef.current().wheelAngle);

            engine.render();

        });

    }, [subscribeFrame]);

    useEffect(() => {

        const container = containerRef.current;

        if (!container) {

            return undefined;

        }

        function redraw() {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            const { width, height } = container.getBoundingClientRect();

            engine.resize(width, height);

            engine.setAngle(getFrameRef.current().wheelAngle);

            engine.render();

        }

        redraw();

        const observer = new ResizeObserver(redraw);

        observer.observe(container);

        return () => observer.disconnect();

    }, []);

    return (

        <div ref={containerRef} className="wheelEngine">

            <canvas ref={canvasRef} aria-hidden="true" />

        </div>

    );

}

import { useEffect, useRef } from "react";

import { TriangleEngine as TriangleEngineCore } from "./TriangleRenderer";

import { calculateWheelRadiusFromContainer } from "./triangleUtils";

import "./triangleEngine.css";

export default function TriangleEngine({ subscribeFrame, getFrame }) {

    const containerRef = useRef(null);

    const canvasRef = useRef(null);

    const engineRef = useRef(null);

    const getFrameRef = useRef(getFrame);

    getFrameRef.current = getFrame;

    useEffect(() => {

        if (!canvasRef.current) {

            return undefined;

        }

        engineRef.current = new TriangleEngineCore(canvasRef.current);

        return () => {

            engineRef.current = null;

        };

    }, []);

    useEffect(() => {

        if (!engineRef.current || !subscribeFrame) {

            return undefined;

        }

        return subscribeFrame(() => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            engine.setAngle(getFrameRef.current().triangleAngle);

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

            engine.setWheelRadius(
                calculateWheelRadiusFromContainer(width)
            );

            engine.setAngle(getFrameRef.current().triangleAngle);

            engine.render();

        }

        redraw();

        const observer = new ResizeObserver(redraw);

        observer.observe(container);

        return () => observer.disconnect();

    }, []);

    return (

        <div ref={containerRef} className="triangleEngine">

            <canvas ref={canvasRef} aria-hidden="true" />

        </div>

    );

}

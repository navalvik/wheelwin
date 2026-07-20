import { AUDIO_TRACKS } from "./audioUtils";

function createWavBuffer(audioContext, samples, sampleRate) {

    const buffer = audioContext.createBuffer(
        1,
        samples.length,
        sampleRate
    );

    buffer.copyToChannel(samples, 0);

    return buffer;

}

function renderTone({
    duration,
    sampleRate,
    frequency,
    gain = 0.25,
    type = "sine"
}) {

    const sampleCount = Math.floor(duration * sampleRate);

    const output = new Float32Array(sampleCount);

    for (let index = 0; index < sampleCount; index += 1) {

        const time = index / sampleRate;

        const envelope = Math.min(1, index / (sampleRate * 0.02))
            * Math.min(1, (sampleCount - index) / (sampleRate * 0.05));

        let sample = 0;

        if (type === "sine") {

            sample = Math.sin((Math.PI * 2) * frequency * time);

        } else if (type === "square") {

            sample = Math.sign(Math.sin((Math.PI * 2) * frequency * time));

        } else if (type === "saw") {

            const phase = (frequency * time) % 1;

            sample = (phase * 2) - 1;

        } else {

            sample = (Math.random() * 2) - 1;

        }

        output[index] = sample * gain * envelope;

    }

    return output;

}

function mixSamples(sampleSets) {

    const length = Math.max(...sampleSets.map((samples) => samples.length));

    const mixed = new Float32Array(length);

    sampleSets.forEach((samples) => {

        for (let index = 0; index < samples.length; index += 1) {

            mixed[index] += samples[index];

        }

    });

    return mixed;

}

export function createPlaceholderBuffers(audioContext) {

    const sampleRate = audioContext.sampleRate;

    const loopDuration = 4;

    const loopSampleCount = Math.floor(loopDuration * sampleRate);

    const organLoop = new Float32Array(loopSampleCount);

    const mechanicalLoop = new Float32Array(loopSampleCount);

    const organFrequencies = [196, 247, 294, 392];

    for (let index = 0; index < loopSampleCount; index += 1) {

        const time = index / sampleRate;

        const wobble = 1 + (Math.sin(time * 2.4) * 0.01);

        let organSample = 0;

        organFrequencies.forEach((frequency, harmonicIndex) => {

            const harmonicGain = 0.16 / (harmonicIndex + 1);

            organSample += Math.sin(
                (Math.PI * 2) * frequency * wobble * time
            ) * harmonicGain;

        });

        organLoop[index] = organSample;

        const mechanicalBase = Math.sin((Math.PI * 2) * 5.5 * time) * 0.08;

        const creak = Math.sin((Math.PI * 2) * 13 * time) * 0.03;

        const noise = (Math.random() * 2 - 1) * 0.015;

        mechanicalLoop[index] = mechanicalBase + creak + noise;

    }

    return {
        [AUDIO_TRACKS.BACKGROUND_MUSIC]: createWavBuffer(
            audioContext,
            organLoop,
            sampleRate
        ),
        [AUDIO_TRACKS.MECHANICAL_LOOP]: createWavBuffer(
            audioContext,
            mechanicalLoop,
            sampleRate
        ),
        [AUDIO_TRACKS.COUNTDOWN_INTRO]: createWavBuffer(
            audioContext,
            mixSamples([
                renderTone({
                    duration: 0.18,
                    sampleRate,
                    frequency: 523,
                    gain: 0.2
                }),
                renderTone({
                    duration: 0.28,
                    sampleRate,
                    frequency: 659,
                    gain: 0.18
                })
            ]),
            sampleRate
        ),
        [AUDIO_TRACKS.SELF_TEST]: createWavBuffer(
            audioContext,
            mixSamples([
                renderTone({
                    duration: 0.85,
                    sampleRate,
                    frequency: 95,
                    gain: 0.14,
                    type: "square"
                }),
                renderTone({
                    duration: 0.85,
                    sampleRate,
                    frequency: 180,
                    gain: 0.08,
                    type: "saw"
                }),
                renderTone({
                    duration: 0.85,
                    sampleRate,
                    frequency: 42,
                    gain: 0.1,
                    type: "noise"
                })
            ]),
            sampleRate
        ),
        [AUDIO_TRACKS.BUTTON_PRESS]: createWavBuffer(
            audioContext,
            renderTone({
                duration: 0.08,
                sampleRate,
                frequency: 760,
                gain: 0.22
            }),
            sampleRate
        ),
        [AUDIO_TRACKS.BUTTON_RELEASE]: createWavBuffer(
            audioContext,
            renderTone({
                duration: 0.1,
                sampleRate,
                frequency: 420,
                gain: 0.18
            }),
            sampleRate
        ),
        [AUDIO_TRACKS.WIN]: createWavBuffer(
            audioContext,
            mixSamples([
                renderTone({
                    duration: 0.35,
                    sampleRate,
                    frequency: 523,
                    gain: 0.2
                }),
                renderTone({
                    duration: 0.45,
                    sampleRate,
                    frequency: 784,
                    gain: 0.18
                })
            ]),
            sampleRate
        ),
        [AUDIO_TRACKS.LOST]: createWavBuffer(
            audioContext,
            mixSamples([
                renderTone({
                    duration: 0.4,
                    sampleRate,
                    frequency: 196,
                    gain: 0.2
                }),
                renderTone({
                    duration: 0.5,
                    sampleRate,
                    frequency: 147,
                    gain: 0.16
                })
            ]),
            sampleRate
        )
    };

}

export async function tryLoadAudioBuffer(audioContext, url) {

    const response = await fetch(url);

    if (!response.ok) {

        throw new Error(`Failed to load audio: ${url}`);

    }

    const arrayBuffer = await response.arrayBuffer();

    return audioContext.decodeAudioData(arrayBuffer);

}

import { EventType, type SimEvent } from '../shared/events.js';
import type { Camera } from './camera.js';
import { viewportToWorldX, viewportToWorldY } from './camera.js';
import { presentation } from './presentation.js';

/**
 * Audio, driven by the simulation's event stream.
 *
 * This is the consumer ARCHITECTURE section 5 had in mind when it argued for a second
 * channel alongside state snapshots. A death cannot be heard by diffing snapshots — the
 * entity simply stops being in the next one — and anything that happens and reverts
 * inside a tick is inaudible entirely. Every sound here comes from an event.
 *
 * The sounds are synthesised rather than sampled. There are no audio assets yet and the
 * pipeline for them is deferred, so an oscillator and a noise burst are the honest
 * placeholder: they prove the routing, the spatialisation and the voice limiting work,
 * and they are replaced by swapping one function when real audio arrives.
 */

const { masterVolume, maxVoices, audibleRadius, minEventGapMs } = presentation.audio;

export interface AudioEngine {
  /** Browsers refuse to start audio without a gesture, so this is called from one. */
  resume(): void;
  readonly running: boolean;
  handle(events: readonly SimEvent[], camera: Camera): void;
  voicesPlayed: number;
  dispose(): void;
}

interface VoiceSpec {
  /** Starting frequency in Hz. */
  readonly frequency: number;
  /** Frequency at the end of the sound; a fall reads as impact, a rise as alarm. */
  readonly endFrequency: number;
  readonly durationMs: number;
  readonly gain: number;
  readonly noise: boolean;
  readonly type: OscillatorType;
}

/**
 * One voice per event type.
 *
 * Chosen so the mix stays legible rather than pretty: a stampede is the loudest and
 * longest thing on the field, construction is soft and brief, and a hit is a short click
 * that survives being played forty times in a second without becoming a drone.
 */
const VOICES: Partial<Record<number, VoiceSpec>> = {
  [EventType.StampedeBegan]: {
    frequency: 90,
    endFrequency: 38,
    durationMs: 900,
    gain: 1,
    noise: true,
    type: 'sawtooth',
  },
  [EventType.Crushed]: {
    frequency: 160,
    endFrequency: 55,
    durationMs: 220,
    gain: 0.85,
    noise: true,
    type: 'square',
  },
  [EventType.Died]: {
    frequency: 320,
    endFrequency: 110,
    durationMs: 260,
    gain: 0.5,
    noise: false,
    type: 'triangle',
  },
  [EventType.Hit]: {
    frequency: 620,
    endFrequency: 420,
    durationMs: 70,
    gain: 0.3,
    noise: false,
    type: 'square',
  },
  [EventType.BuildingCompleted]: {
    frequency: 380,
    endFrequency: 720,
    durationMs: 320,
    gain: 0.4,
    noise: false,
    type: 'sine',
  },
  [EventType.BuildingPlaced]: {
    frequency: 240,
    endFrequency: 200,
    durationMs: 110,
    gain: 0.25,
    noise: false,
    type: 'sine',
  },
  [EventType.Starved]: {
    frequency: 200,
    endFrequency: 140,
    durationMs: 400,
    gain: 0.3,
    noise: false,
    type: 'sine',
  },
};

export function createAudioEngine(): AudioEngine {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  let active = 0;
  /** Last time each event type sounded, so forty simultaneous hits are not forty voices. */
  const lastPlayed = new Map<number, number>();

  const engine: AudioEngine = {
    voicesPlayed: 0,

    get running(): boolean {
      return context !== null && context.state === 'running';
    },

    resume(): void {
      if (context === null) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor === undefined) return;

        context = new Ctor();
        master = context.createGain();
        master.gain.value = masterVolume;
        master.connect(context.destination);

        // One second of white noise, reused by every percussive voice.
        const frames = context.sampleRate;
        noiseBuffer = context.createBuffer(1, frames, context.sampleRate);
        const channel = noiseBuffer.getChannelData(0);
        for (let i = 0; i < frames; i++) channel[i] = Math.random() * 2 - 1;
      }
      void context.resume();
    },

    handle(events, camera): void {
      if (context === null || master === null || context.state !== 'running') return;

      // What the camera is looking at, in world coordinates: sound is placed relative to
      // the view, not to any unit, because the player is the camera.
      const centreX = viewportToWorldX(camera, camera.viewportWidth / 2, camera.viewportHeight / 2, 0);
      const centreY = viewportToWorldY(camera, camera.viewportWidth / 2, camera.viewportHeight / 2, 0);
      const nowMs = performance.now();

      for (const event of events) {
        const spec = VOICES[event.type];
        if (spec === undefined) continue;

        const dx = event.x - centreX;
        const dy = event.y - centreY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > audibleRadius) continue;

        const since = nowMs - (lastPlayed.get(event.type) ?? -Infinity);
        if (since < minEventGapMs) continue;
        if (active >= maxVoices) break;

        lastPlayed.set(event.type, nowMs);
        play(context, master, noiseBuffer, spec, 1 - distance / audibleRadius, dx / audibleRadius);
        engine.voicesPlayed++;
        active++;
        window.setTimeout(() => {
          active--;
        }, spec.durationMs);
      }
    },

    dispose(): void {
      void context?.close();
      context = null;
      master = null;
    },
  };

  return engine;
}

function play(
  context: AudioContext,
  master: GainNode,
  noiseBuffer: AudioBuffer | null,
  spec: VoiceSpec,
  nearness: number,
  pan: number,
): void {
  const now = context.currentTime;
  const seconds = spec.durationMs / 1000;

  const gain = context.createGain();
  gain.gain.setValueAtTime(spec.gain * nearness * nearness, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan * 2));

  gain.connect(panner);
  panner.connect(master);

  const oscillator = context.createOscillator();
  oscillator.type = spec.type;
  oscillator.frequency.setValueAtTime(spec.frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, spec.endFrequency), now + seconds);
  oscillator.connect(gain);
  oscillator.start(now);
  oscillator.stop(now + seconds);

  // Percussive voices get a noise layer, which is what makes hooves read as hooves
  // rather than as a tone.
  if (spec.noise && noiseBuffer !== null) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(spec.frequency * 6, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, spec.endFrequency * 3), now + seconds);

    source.connect(filter);
    filter.connect(gain);
    source.start(now);
    source.stop(now + seconds);
  }
}

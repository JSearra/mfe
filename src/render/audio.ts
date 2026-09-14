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
  /**
   * The continuous half: what the field sounds like, rather than what just happened.
   *
   * Events cannot carry this. A herd grazing and a column marching are STATES — nothing
   * happens at any particular tick — so they are read from the view each frame and
   * sounded on their own cadence. Aggregated rather than per entity: forty cattle are
   * one herd making one sound, not forty voices competing for the eight the mixer has.
   */
  ambience(view: AmbienceView, camera: Camera): void;
  /** Played immediately on a click, before the simulation has seen the order. */
  acknowledge(kind: 'move' | 'attack' | 'herd'): void;
  voicesPlayed: number;
  dispose(): void;
}

/** The slice of the interpolated view the ambience reads. */
export interface AmbienceView {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly kind: Uint8Array;
  readonly animState: Uint8Array;
  readonly stressPct: Uint8Array;
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

const KIND_CATTLE = 1;
const ANIM_IDLE = 0;
const ANIM_STAMPEDE = 2;

/**
 * The ambient voices, and how often each may sound.
 *
 * Deliberately sparse. Continuous audio in an RTS is a bed the player stops hearing
 * within a minute, and the moment it stops being heard it is only masking the sounds
 * that matter. These are occasional enough to stay noticeable.
 */
const AMBIENT: Readonly<Record<string, { spec: VoiceSpec; everyMs: number }>> = {
  // A hoof-fall texture for troops on the move. One pulse for the whole column, its
  // volume carrying how many are marching, because thirty sets of footsteps is a drone.
  march: {
    spec: { frequency: 150, endFrequency: 70, durationMs: 110, gain: 0.16, noise: true, type: 'triangle' },
    everyMs: 460,
  },
  // Cattle at rest. Low, slow and infrequent — the sound of nothing being wrong.
  lowing: {
    spec: { frequency: 155, endFrequency: 118, durationMs: 620, gain: 0.2, noise: false, type: 'sawtooth' },
    everyMs: 3400,
  },
  // The same herd, uneasy. Higher and more often: this is the audible half of the stress
  // readout the rings carry visually, and it arrives before a player is looking.
  restless: {
    spec: { frequency: 240, endFrequency: 180, durationMs: 420, gain: 0.26, noise: false, type: 'sawtooth' },
    everyMs: 1100,
  },
  // A herd already running. Sustained rumble under everything else; StampedeBegan fires
  // once, and a stampede lasts far longer than once.
  rumble: {
    spec: { frequency: 74, endFrequency: 52, durationMs: 700, gain: 0.34, noise: true, type: 'sawtooth' },
    everyMs: 520,
  },
};

/** Immediate feedback on a click, before the order has reached the simulation. */
const ACKNOWLEDGE: Readonly<Record<string, VoiceSpec>> = {
  move: { frequency: 520, endFrequency: 700, durationMs: 70, gain: 0.13, noise: false, type: 'triangle' },
  attack: { frequency: 300, endFrequency: 190, durationMs: 110, gain: 0.18, noise: true, type: 'square' },
  herd: { frequency: 400, endFrequency: 470, durationMs: 130, gain: 0.14, noise: false, type: 'sine' },
};

export interface AmbienceMix {
  /** Which herd voice, if any, should be sounding. */
  readonly herd: 'lowing' | 'restless' | 'rumble' | null;
  readonly herdLoudness: number;
  readonly herdPan: number;
  /** Loudness of the marching texture, or 0 for silence. */
  readonly march: number;
}

/**
 * What the field should sound like, from what is on screen.
 *
 * Separated from the playing so the policy can be tested without an AudioContext — and
 * the policy is the interesting half. Two rules are doing the work:
 *
 * Contributions are AGGREGATED, not per entity. Forty cattle are one herd making one
 * sound; sounding each of them would spend the whole voice budget on the least
 * informative thing on the field.
 *
 * And a herd makes ONE sound at a time, the most urgent one it has. A stampeding herd
 * silences its own grazing, because a player who can hear both learns nothing from
 * either.
 */
export function chooseAmbience(view: AmbienceView, centreX: number, centreY: number): AmbienceMix {
  let marching = 0;
  let grazing = 0;
  let uneasy = 0;
  let running = 0;
  let herdPan = 0;
  let herdWeight = 0;

  for (let i = 0; i < view.count; i++) {
    const dx = view.x[i]! - centreX;
    const dy = view.y[i]! - centreY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > audibleRadius) continue;
    // Squared, so the far edge of the audible radius contributes almost nothing and the
    // mix does not swell every time the camera drifts across open ground.
    const nearness = 1 - distance / audibleRadius;
    const weight = nearness * nearness;

    if (view.kind[i] === KIND_CATTLE) {
      if (view.animState[i] === ANIM_STAMPEDE) running += weight;
      else if (view.stressPct[i]! > 90) uneasy += weight;
      else grazing += weight;
      herdPan += (dx / audibleRadius) * weight;
      herdWeight += weight;
    } else if (view.animState[i] !== ANIM_IDLE) {
      marching += weight;
    }
  }

  const pan = herdWeight > 0 ? herdPan / herdWeight : 0;
  const herd =
    running > 0.2 ? 'rumble' : uneasy > 0.2 ? 'restless' : grazing > 0.3 ? 'lowing' : null;
  // Gentle scaling, so the channel has somewhere to go. At the first set of factors a
  // mere four cattle standing under the camera already clipped at full volume, which
  // means a handful and a whole herd sound identical and the loudness carries no
  // information at all. A stampede is the exception and is meant to dominate.
  const herdLoudness =
    herd === 'rumble'
      ? Math.min(1, 0.45 + running * 0.2)
      : herd === 'restless'
        ? Math.min(1, uneasy * 0.16)
        : herd === 'lowing'
          ? Math.min(1, grazing * 0.1)
          : 0;

  return {
    herd,
    herdLoudness,
    herdPan: pan,
    march: marching > 0.25 ? Math.min(1, marching * 0.5) : 0,
  };
}

export function createAudioEngine(): AudioEngine {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  let active = 0;
  /** Last time each event type sounded, so forty simultaneous hits are not forty voices. */
  const lastPlayed = new Map<number, number>();

  /** Last time each ambient channel sounded, so each keeps its own cadence. */
  const lastAmbient = new Map<string, number>();

  function sound(channel: string, nowMs: number, loudness: number, pan: number): void {
    const entry = AMBIENT[channel]!;
    if (nowMs - (lastAmbient.get(channel) ?? -Infinity) < entry.everyMs) return;
    if (active >= maxVoices) return;
    if (context === null || master === null) return;

    lastAmbient.set(channel, nowMs);
    play(context, master, noiseBuffer, entry.spec, loudness, pan);
    engine.voicesPlayed++;
    active++;
    window.setTimeout(() => {
      active--;
    }, entry.spec.durationMs);
  }

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

    ambience(view, camera): void {
      if (context === null || master === null || context.state !== 'running') return;

      const centreX = viewportToWorldX(camera, camera.viewportWidth / 2, camera.viewportHeight / 2, 0);
      const centreY = viewportToWorldY(camera, camera.viewportWidth / 2, camera.viewportHeight / 2, 0);
      const nowMs = performance.now();

      const mix = chooseAmbience(view, centreX, centreY);
      if (mix.herd !== null) sound(mix.herd, nowMs, mix.herdLoudness, mix.herdPan);
      if (mix.march > 0) sound('march', nowMs, mix.march, 0);
    },

    acknowledge(kind): void {
      if (context === null || master === null || context.state !== 'running') return;
      // Unspatialised and unthrottled by distance, because this is the player's own
      // click answering back. ARCHITECTURE section 6: local feedback fires immediately
      // and never waits for the round trip — that split is what makes a renderer running
      // 75ms behind the simulation feel instant.
      play(context, master, noiseBuffer, ACKNOWLEDGE[kind]!, 1, 0);
      engine.voicesPlayed++;
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

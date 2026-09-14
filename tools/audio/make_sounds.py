"""
Synthesise the game's sound set, deterministically, from nothing.

    tools/art/.venv/bin/python tools/audio/make_sounds.py --out public/assets/audio

Same bargain as the rest of the pipeline (ADR-0015): procedural rather than bought or
downloaded. It needs no licence, no attribution and no asset store account; the same
invocation produces byte-identical output, so a sound can be regenerated after a tweak
rather than archived; and it costs nothing to try ten variations of a hoofbeat.

The honest limit is the same too. This is physical modelling with oscillators and filters,
not a recording of a cow. It aims at RECOGNISABLE rather than real: the right fundamental,
the right formants, the right envelope, the right amount of breath — enough that a player
knows what they are hearing without being told. A field recording would beat it, and the
loader is built so dropping real files in place needs no code change.

Everything here is plain numpy. No scipy: the filters are two-pole resonators and one-pole
smoothers written out, which is a dozen lines and removes a dependency from a tools venv
that already carries a diffusion model.
"""

import argparse
import math
import pathlib
import struct
import wave

import numpy as np

RATE = 44_100


# ---------------------------------------------------------------------------
# Small DSP kit. Written out rather than imported, see the module docstring.
# ---------------------------------------------------------------------------


def noise(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1.0, 1.0, n)


def resonator(x: np.ndarray, freq: float, q: float) -> np.ndarray:
    """
    A two-pole bandpass. This is what turns noise into a THING.

    A formant is a resonance, so a vowel-like animal call is a handful of these over a
    buzzy source; a hoof on earth is one of them over a noise burst. Without resonance
    every synthetic sound is either a pure tone or a hiss, which is exactly why the
    oscillator placeholders it replaces sounded synthetic.
    """
    w = 2.0 * math.pi * freq / RATE
    r = math.exp(-w / (2.0 * q))
    a1 = -2.0 * r * math.cos(w)
    a2 = r * r
    gain = (1.0 - r) * math.sqrt(1.0 - 2.0 * r * math.cos(2.0 * w) + r * r)

    y = np.zeros_like(x)
    z1 = z2 = 0.0
    for i in range(x.size):
        out = gain * x[i] - a1 * z1 - a2 * z2
        z2 = z1
        z1 = out
        y[i] = out
    return y


def onepole(x: np.ndarray, cutoff: float, poles: int = 1) -> np.ndarray:
    """
    A lowpass, cascaded for a steeper slope.

    One pole is 6dB an octave, which sounds like a lot and is not: white noise through a
    single pole at 120Hz still carries enough energy at 3kHz to dominate the spectral
    centroid, and a "thud" built on it measured brighter than the crack it was supposed
    to sit under. Four poles is 24dB an octave and actually removes the top.
    """
    a = math.exp(-2.0 * math.pi * cutoff / RATE)
    y = x
    for _ in range(poles):
        out = np.zeros_like(y)
        z = 0.0
        for i in range(y.size):
            z = (1.0 - a) * y[i] + a * z
            out[i] = z
        y = out
    return y


def envelope(n: int, attack: float, decay: float, sustain: float, release: float) -> np.ndarray:
    """Attack-decay-sustain-release, in seconds, clamped to fit."""
    a = max(1, int(attack * RATE))
    d = max(1, int(decay * RATE))
    r = max(1, int(release * RATE))
    s = max(0, n - a - d - r)
    return np.concatenate(
        [
            np.linspace(0.0, 1.0, a),
            np.linspace(1.0, sustain, d),
            np.full(s, sustain),
            np.linspace(sustain, 0.0, n - a - d - s),
        ]
    )[:n]


def harmonics(n: int, f0: np.ndarray, partials: int, tilt: float) -> np.ndarray:
    """
    A buzzy, harmonically rich source from a time-varying pitch.

    Summed partials rather than a sawtooth oscillator because the pitch bends through the
    sound, and a bend is what stops a synthetic call reading as a doorbell.
    """
    phase = np.cumsum(2.0 * math.pi * f0 / RATE)
    out = np.zeros(n)
    for k in range(1, partials + 1):
        out += np.sin(phase * k) / (k**tilt)
    return out


def write_wav(path: pathlib.Path, samples: np.ndarray) -> None:
    peak = float(np.max(np.abs(samples))) or 1.0
    # Normalised to a consistent headroom so the mixer's own gains stay meaningful and
    # one sample cannot be four times louder than the rest by accident.
    scaled = np.clip(samples / peak * 0.82, -1.0, 1.0)
    pcm = (scaled * 32767.0).astype(np.int16)

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(struct.pack(f"<{pcm.size}h", *pcm.tolist()))


# ---------------------------------------------------------------------------
# The sounds.
# ---------------------------------------------------------------------------


def cattle_low(rng: np.random.Generator, seconds: float = 1.05, pitch: float = 1.0) -> np.ndarray:
    """
    A cow calling.

    Three things make it read as an animal rather than a synthesiser. The pitch BENDS —
    up into the call and sagging away at the end, which is the shape of a breath running
    out. The formants sit where a large vocal tract puts them, low and close together.
    And there is audible breath: a cow is a bellows, and a call with no noise in it is a
    horn.
    """
    n = int(seconds * RATE)
    t = np.linspace(0.0, seconds, n)

    base = 118.0 * pitch
    bend = base * (1.0 + 0.18 * np.sin(math.pi * np.clip(t / seconds * 1.15, 0, 1)) - 0.12 * (t / seconds) ** 2)
    # A little wobble. Nothing alive holds a pitch perfectly steady.
    bend *= 1.0 + 0.012 * np.sin(2.0 * math.pi * 5.5 * t) + 0.006 * rng.standard_normal(n).cumsum() / n

    source = harmonics(n, bend, partials=26, tilt=1.05)
    breath = onepole(noise(n, rng), 1800.0, poles=2) * 0.5

    voiced = (
        resonator(source, 240.0 * pitch, 5.0) * 1.0
        + resonator(source, 620.0 * pitch, 6.0) * 0.55
        + resonator(source, 1180.0 * pitch, 7.0) * 0.22
    )
    breathy = resonator(breath, 700.0, 1.4) * 0.35

    env = envelope(n, 0.09, 0.22, 0.72, 0.42)
    return (voiced + breathy) * env


def hoofbeat(rng: np.random.Generator, seconds: float = 0.16, weight: float = 1.0) -> np.ndarray:
    """
    One hoof on dry ground: a thud with a crack on the front of it.

    The crack is the hoof, the thud is the ground. Earth is damped, so both decay fast —
    a long tail is what makes synthetic percussion sound like a drum machine.
    """
    n = int(seconds * RATE)
    src = noise(n, rng)

    crack = resonator(src, 1250.0, 2.2) * np.exp(-np.linspace(0, 1, n) * 34.0)
    body = resonator(src, 155.0 * weight, 3.4) * np.exp(-np.linspace(0, 1, n) * 15.0)
    thump = onepole(src, 150.0, poles=4) * np.exp(-np.linspace(0, 1, n) * 22.0)

    # Weighted toward the low end. The first pass measured a spectral centroid near
    # 2.9kHz, which is a hoof on stone; dry earth is damped and the thud should carry it.
    return crack * 0.22 + body * 1.0 + thump * 0.85


def stampede_rumble(rng: np.random.Generator, seconds: float = 1.6) -> np.ndarray:
    """
    A herd at the run: many hooves, too many to count, over a ground rumble.

    Scattered rather than regular. Evenly spaced beats read as one large animal or a
    machine; a stampede is dozens of animals out of step with each other.
    """
    n = int(seconds * RATE)
    out = np.zeros(n)

    for _ in range(46):
        at = int(rng.uniform(0, seconds - 0.2) * RATE)
        beat = hoofbeat(rng, 0.16, weight=float(rng.uniform(0.8, 1.25)))
        end = min(n, at + beat.size)
        out[at:end] += beat[: end - at] * float(rng.uniform(0.35, 1.0))

    ground = onepole(noise(n, rng), 90.0, poles=4)
    ground = resonator(ground, 52.0, 1.2) * 2.4
    swell = envelope(n, 0.25, 0.3, 0.85, 0.45)

    return (out * 0.55 + ground) * swell


def impact(rng: np.random.Generator, seconds: float = 0.22) -> np.ndarray:
    """Hide shield taking a blow: a dull knock with a short woody ring."""
    n = int(seconds * RATE)
    src = noise(n, rng)
    knock = resonator(src, 320.0, 4.0) * np.exp(-np.linspace(0, 1, n) * 20.0)
    slap = onepole(src, 1400.0, poles=2) * np.exp(-np.linspace(0, 1, n) * 48.0)
    # Likewise: 5.6kHz is a stick on a plank, not a blow on stretched hide.
    return knock + slap * 0.3


SOUNDS = {
    "cattle-low-1": lambda rng: cattle_low(rng, 1.05, 1.0),
    "cattle-low-2": lambda rng: cattle_low(rng, 0.92, 1.12),
    "cattle-low-3": lambda rng: cattle_low(rng, 1.2, 0.9),
    "cattle-restless": lambda rng: cattle_low(rng, 0.62, 1.35),
    "hoofbeat-1": lambda rng: hoofbeat(rng, 0.16, 1.0),
    "hoofbeat-2": lambda rng: hoofbeat(rng, 0.15, 1.15),
    "stampede": stampede_rumble,
    "impact": impact,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="public/assets/audio")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    for index, (name, make) in enumerate(sorted(SOUNDS.items())):
        # Per-sound seed derived from the name's position, so regenerating one does not
        # churn the others — the same rule the tile generator had to learn.
        rng = np.random.default_rng(args.seed + index * 101)
        samples = make(rng)
        path = out / f"{name}.wav"
        write_wav(path, samples)
        print(f"  {name}: {samples.size / RATE:.2f}s")

    print(f"[make_sounds] {len(SOUNDS)} sounds -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

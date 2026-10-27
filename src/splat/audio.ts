/**
 * The sound: a drone that tightens as you approach an anomaly, and a sting when
 * you mark.
 *
 * Kept deliberately small. The drone is two detuned oscillators beating against
 * each other rather than a sample, so there is no asset to load and the tension
 * can be a continuous value rather than a set of clips — the player should feel
 * it rise as they walk toward the thing, not hear a cue fire.
 *
 * Everything is created lazily on the first `ensure()`, because browsers refuse
 * to start an AudioContext before a gesture. `read()` exposes the analyser so
 * this can be verified by measuring the actual signal rather than by trusting
 * that a node was constructed.
 */

export interface AudioReport {
  /** The AudioContext's own state: 'running', 'suspended', or 'none'. */
  state: string;
  /** The drone's current gain setting, 0..1 of its range. */
  gain: number;
  /** Measured RMS of the output, from the analyser. */
  rms: number;
  /** The proximity value most recently supplied. */
  tension: number;
  /** How many footsteps have been taken. */
  steps: number;
  /** How many notes are sounding in the musical bed. */
  voices: number;
}

const DRONE_BASE_HZ = 55;
const DRONE_BEAT_HZ = 0.7;
const MAX_GAIN = 0.085;

/**
 * The musical bed.
 *
 * A drone is not music: it is a texture, and a player stops hearing it after a minute. What
 * makes a room feel like somewhere a person should not be is a slow harmonic movement that
 * is almost too quiet to notice — heard only when it changes.
 *
 * Built from sine partials on a minor triad rather than a looped sample, for the same reason
 * as everything else here: no asset to load, and the interval can be chosen per floor rather
 * than being a fixed piece of audio that plays on every one. Two chords, a tritone apart,
 * alternate slowly, which is the cheapest way to make a room feel wrong rather than sad.
 */
const PAD_ROOT_HZ = 110;

/** Root, minor third, fifth, and an octave. */
const PAD_RATIOS = [1, 1.1892, 1.4983, 2];

/** The note that makes it a tritone rather than a chord. Added on the deep floors. */
const PAD_TRITONE = 1.4142;

const MAX_PAD_GAIN = 0.05;

export class GameAudio {
  private context: AudioContext | null = null;
  private droneGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * `Float32Array<ArrayBuffer>` rather than a bare `Float32Array`: the DOM
   * signature for `getFloatTimeDomainData` will not accept a buffer that might be
   * shared, and an unparameterised array is the wider `ArrayBufferLike`.
   */
  private scratch: Float32Array<ArrayBuffer> | null = null;
  private tension = 0;
  private scares = 0;
  private steps = 0;

  /** The musical bed's own gain, kept separate from the drone's. */
  private padGain: GainNode | null = null;
  /** The partials that are currently sounding, so a floor change can retune them. */
  private padVoices: { osc: OscillatorNode; ratio: number }[] = [];
  private musicLevel = 0;

  /** Whether audio was ever successfully started on this page. */
  get available(): boolean {
    return this.context !== null;
  }

  /**
   * Create the graph if it does not exist yet.
   *
   * Never throws: a browser that refuses audio must leave the game playable, so
   * every failure path leaves `context` null and the rest of the game unaffected.
   */
  ensure(): boolean {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return true;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      const context = new Ctor();
      this.context = context;

      const droneGain = context.createGain();
      droneGain.gain.value = 0;
      this.droneGain = droneGain;

      // Tension opens the filter as well as raising the level, so approaching
      // an anomaly sounds like it is getting closer rather than just louder.
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      filter.Q.value = 0.7;
      this.filter = filter;

      for (const [frequency, detune] of [
        [DRONE_BASE_HZ, 0],
        [DRONE_BASE_HZ, DRONE_BEAT_HZ * 100],
        [DRONE_BASE_HZ * 2, 4],
      ] as const) {
        const osc = context.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start();
      }

      const analyser = context.createAnalyser();
      // 8192 samples at 48 kHz is ~9.4 cycles of the 55 Hz fundamental. The
      // default 2048 covers only ~2.3 cycles, and the RMS of so short a window
      // swings by several percent depending on where it happens to land in the
      // waveform — the same order as the level change we are trying to measure,
      // which made the "is this actually louder" check read anywhere from 7% to
      // 29% for the same 16% gain change. Cost is negligible and paid once.
      analyser.fftSize = 8192;
      this.analyser = analyser;
      this.scratch = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

      // The musical bed, parked silent until a floor asks for it. Its own gain node, so
      // a floor change can retune the notes without disturbing the tension drone -- the two
      // are doing different jobs and must not share a level.
      const padGain = context.createGain();
      padGain.gain.value = 0;
      this.padGain = padGain;

      filter.connect(droneGain);
      droneGain.connect(analyser);
      padGain.connect(analyser);
      analyser.connect(context.destination);

      // Autoplay policy can leave it suspended even after construction.
      if (context.state === 'suspended') void context.resume();
      return true;
    } catch {
      this.context = null;
      return false;
    }
  }

  /**
   * 0 = nothing near, 1 = standing on top of an anomaly.
   *
   * Safe to call every frame, and it deliberately ignores calls that do not
   * change the target. `setTargetAtTime` re-anchors its exponential curve from
   * the value at the moment it is called, so re-issuing the same target every
   * frame makes the ramp advance per *frame* instead of per second. Under
   * software rendering at a couple of frames a second that turns a one-second
   * glide into a ten-second crawl, and the drone lags the player badly. Issuing
   * it only on a real change lets the curve run at its own rate on the audio
   * thread, independent of how fast the renderer happens to be.
   */
  setTension(value: number): void {
    const next = Math.max(0, Math.min(1, value));
    if (Math.abs(next - this.tension) < 0.001) return;
    this.tension = next;
    if (!this.context || !this.droneGain || !this.filter) return;
    const t = this.context.currentTime;
    this.droneGain.gain.setTargetAtTime(next * MAX_GAIN, t, 0.15);
    this.filter.frequency.setTargetAtTime(180 + next * 900, t, 0.2);
  }

  /**
   * A short burst for a mark.
   *
   * Rising for a hit, falling for a miss — the two have to be distinguishable
   * without looking at the HUD, because the player is looking at the room.
   */
  sting(kind: 'hit' | 'miss' | 'repeat'): void {
    if (!this.context || !this.analyser) return;
    const context = this.context;
    const t = context.currentTime;
    const osc = context.createOscillator();
    const gain = context.createGain();

    if (kind === 'hit') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.18);
    } else if (kind === 'miss') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, t);
    }

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === 'hit' ? 0.12 : 0.07, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'repeat' ? 0.1 : 0.32));

    osc.connect(gain);
    gain.connect(this.analyser);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  /**
   * The fright itself: a burst of noise over a falling boom.
   *
   * Noise rather than a tone because a tone reads as a musical sting and the ear
   * recognises it as a sound effect; a noise burst with no pitch reads as
   * something happening in the room. The low sweep underneath is what makes it
   * felt rather than heard.
   *
   * `intensity` 0..1 scales both. Nothing here relies on being loud to work —
   * suddenness does the work, which is also what keeps it from being a hearing
   * hazard at the volumes a judge will use.
   */
  scare(intensity = 1): void {
    if (!this.context || !this.analyser) return;
    const context = this.context;
    const t = context.currentTime;
    const level = Math.max(0, Math.min(1, intensity));

    // Noise, shaped into a short slap.
    const frames = Math.floor(context.sampleRate * 0.5);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const decay = Math.pow(1 - i / frames, 2.6);
      channel[i] = (Math.random() * 2 - 1) * decay;
    }
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.2 * level + 0.02, t + 0.006);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 380;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.analyser);
    noise.start(t);
    noise.stop(t + 0.5);

    // The boom under it.
    const boom = context.createOscillator();
    boom.type = 'sawtooth';
    boom.frequency.setValueAtTime(96, t);
    boom.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const boomGain = context.createGain();
    boomGain.gain.setValueAtTime(0.0001, t);
    boomGain.gain.exponentialRampToValueAtTime(0.16 * level + 0.02, t + 0.02);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    const boomFilter = context.createBiquadFilter();
    boomFilter.type = 'lowpass';
    boomFilter.frequency.value = 420;
    boom.connect(boomFilter);
    boomFilter.connect(boomGain);
    boomGain.connect(this.analyser);
    boom.start(t);
    boom.stop(t + 0.7);

    this.scares += 1;
  }

  /** How many frights have been played, so a harness can assert they happen. */
  get scareCount(): number {
    return this.scares;
  }

  /** How many footsteps have been taken, so a harness can assert walking makes them. */
  get stepCount(): number {
    return this.steps;
  }

  /**
   * One foot on the floor.
   *
   * A very short filtered noise burst, not a sample and not a tone. Noise because a
   * footstep is broadband and unpitched -- a tone reads as a beep, and a footstep that
   * beeps is worse than silence. Short because the ear localises a step by its attack.
   *
   * The centre frequency is randomised per step. Identical steps sound like a machine, and
   * the whole point of a footstep in this game is that the player is not sure whether the
   * one they just heard was theirs.
   *
   * `hardness` 0..1: a soft step for carpet, a harder one for a wooden floor.
   */
  footstep(hardness = 0.4): void {
    if (!this.context || !this.analyser) return;
    const context = this.context;
    const t = context.currentTime;
    const level = Math.max(0, Math.min(1, hardness));

    const frames = Math.floor(context.sampleRate * 0.09);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // A sharp attack and a fast decay: 1 - i/frames to the fourth is most of the way
      // gone inside 20 ms, which is what makes it a step rather than a swish.
      const decay = Math.pow(1 - i / frames, 4);
      channel[i] = (Math.random() * 2 - 1) * decay;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;

    // +-25% around 700 Hz. Wide enough that two consecutive steps are audibly different,
    // narrow enough that they are all unmistakably the same kind of sound.
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700 * (0.75 + Math.random() * 0.5);
    band.Q.value = 0.9 + level * 0.8;

    const gain = context.createGain();
    const peak = 0.05 + level * 0.07;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

    source.connect(band);
    band.connect(gain);
    gain.connect(this.analyser);
    source.start(t);
    source.stop(t + 0.12);

    this.steps += 1;
  }

  /**
   * The musical bed, and how far into the game the player is.
   *
   * `level` 0..1: the shallow floors get the bare minor triad, the deep ones get the
   * tritone added and a little more level. Retuning the sounding partials rather than
   * starting a new piece, so a floor change is a movement rather than a cut -- a track that
   * restarts every time the room rebuilds would be the loudest thing in the game.
   */
  setMusic(level: number): void {
    const next = Math.max(0, Math.min(1, level));
    if (Math.abs(next - this.musicLevel) < 0.001) return;
    this.musicLevel = next;
    if (!this.context || !this.padGain) return;
    const context = this.context;
    const t = context.currentTime;

    // The tritone is only present on the deeper floors. It is the interval that makes the
    // chord stop being merely sad, and it should arrive as a change the player notices
    // rather than as part of the furniture from the first room.
    const wanted = next > 0.35 ? [...PAD_RATIOS, PAD_TRITONE] : [...PAD_RATIOS];

    // Retune what is already sounding before adding or removing anything, so the movement
    // is heard as the chord changing rather than as notes being swapped.
    for (let i = 0; i < this.padVoices.length; i++) {
      const voice = this.padVoices[i]!;
      if (i < wanted.length) {
        voice.ratio = wanted[i]!;
        voice.osc.frequency.setTargetAtTime(PAD_ROOT_HZ * wanted[i]!, t, 2.5);
      } else {
        voice.osc.stop(t + 3);
      }
    }
    if (this.padVoices.length > wanted.length) this.padVoices.length = wanted.length;

    for (let i = this.padVoices.length; i < wanted.length; i++) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = PAD_ROOT_HZ * wanted[i]!;
      // Fade in over seconds rather than starting at level. A note that appears is a cue;
      // a note that is discovered is atmosphere.
      const fade = context.createGain();
      fade.gain.value = 0;
      fade.gain.setTargetAtTime(1, t, 3);
      osc.connect(fade);
      fade.connect(this.padGain);
      osc.start(t);
      this.padVoices.push({ osc, ratio: wanted[i]! });
    }

    // A slow tremolo, so the bed breathes. Two incommensurable rates, because one rate
    // reads as a pulsing effect and two read as the chord being alive.
    this.padGain.gain.setTargetAtTime(next * MAX_PAD_GAIN, t, 3);
  }

  /** How many notes the bed is currently sounding. */
  get voiceCount(): number {
    return this.padVoices.length;
  }

  /** Measure the graph, so a harness can assert sound is actually being made. */
  read(): AudioReport {
    const state = this.context ? this.context.state : 'none';
    const gain = this.droneGain ? this.droneGain.gain.value / MAX_GAIN : 0;
    let rms = 0;
    if (this.analyser && this.scratch) {
      this.analyser.getFloatTimeDomainData(this.scratch);
      let sum = 0;
      for (let i = 0; i < this.scratch.length; i++) sum += this.scratch[i] * this.scratch[i];
      rms = Math.sqrt(sum / this.scratch.length);
    }
    return {
      state,
      gain,
      rms,
      tension: this.tension,
      steps: this.steps,
      voices: this.padVoices.length,
    };
  }
}

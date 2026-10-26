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
}

const DRONE_BASE_HZ = 55;
const DRONE_BEAT_HZ = 0.7;
const MAX_GAIN = 0.085;

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
      analyser.fftSize = 2048;
      this.analyser = analyser;
      this.scratch = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

      filter.connect(droneGain);
      droneGain.connect(analyser);
      analyser.connect(context.destination);

      // Autoplay policy can leave it suspended even after construction.
      if (context.state === 'suspended') void context.resume();
      return true;
    } catch {
      this.context = null;
      return false;
    }
  }

  /** 0 = nothing near, 1 = standing on top of an anomaly. */
  setTension(value: number): void {
    this.tension = Math.max(0, Math.min(1, value));
    if (!this.context || !this.droneGain || !this.filter) return;
    const t = this.context.currentTime;
    // Ramped, not assigned: a step change in gain clicks.
    this.droneGain.gain.setTargetAtTime(this.tension * MAX_GAIN, t, 0.15);
    this.filter.frequency.setTargetAtTime(180 + this.tension * 900, t, 0.2);
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
    return { state, gain, rms, tension: this.tension };
  }
}

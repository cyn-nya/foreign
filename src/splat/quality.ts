/**
 * Adaptive render resolution.
 *
 * The brief for this was "以流畅度为基准" — smoothness is the baseline, and
 * quality is whatever is left over. That is not a thing to tune by hand once and
 * hope: the machine that plays this is not the machine it was built on, and a
 * fixed resolution is either too heavy for a laptop or wasteful on a desktop.
 *
 * So the game measures its own frame rate and moves the render resolution:
 * `IViewerConfig.pixelRatio` scales the buffer the reconstruction is rasterised
 * into, so dropping it costs sharpness and buys back time roughly with the square
 * of the factor.
 *
 * The logic here is pure and separate from the viewer on purpose — this is the
 * part that can be wrong in a way a screenshot will not reveal, because a
 * controller that thrashes between two levels still renders a correct-looking
 * frame.
 */

/**
 * Render-resolution multipliers, ascending.
 *
 * The floor is 0.4 rather than something smaller because below roughly this the
 * gaussian splat loses the fine structure it is made of and the room turns to
 * mush — at which point the frame rate is no longer the thing costing the player
 * the game.
 */
export const QUALITY_LEVELS = [0.4, 0.55, 0.7, 0.85, 1] as const;

/**
 * The level a player starts on, before anything has been measured.
 *
 * The middle, and that is a change made on evidence rather than on taste.
 *
 * This used to be the top. The argument for the top was that a good machine should never be
 * shown a soft image, and the note on `PANIC_FPS` even priced the alternative: "twenty seconds
 * of a slideshow before the game is playable -- and the player has usually given up by then."
 * That price was accepted for a hypothetical player. Then the one person who has actually
 * played it reported the machine "卡的几乎很难玩" and an F3 line reading 6.9 fps, which is
 * exactly the slideshow, and it is the only impression they formed of the game.
 *
 * Starting in the middle halves the worst case: two steps to the floor instead of four. On a
 * capable machine it costs at most a second or two of a slightly softer image before the
 * controller measures spare capacity and climbs, and 0.7x of a gaussian splat field is not
 * meaningfully different from 1.0x -- the reconstruction is not text. The asymmetry is the
 * whole argument: the fast machine pays a fraction of a second, and the slow machine is spared
 * the twenty seconds that decide whether it is played at all.
 *
 * This cannot be validated on the machine it was written on, which renders an empty room at
 * under two frames a second. What *is* verified is the shape: the worst-case descent is two
 * steps, the ascent is unbounded, and neither depends on knowing the player's hardware.
 */
export const DEFAULT_QUALITY_LEVEL = Math.floor((QUALITY_LEVELS.length - 1) / 2);

/**
 * The frame rate the controller aims to stay above, and the rate it treats as
 * spare capacity.
 *
 * These are far apart deliberately. Equal thresholds make a controller that
 * changes its mind every time it looks, and a resolution that visibly breathes
 * while you walk is worse than one that is simply a little low.
 */
export const TARGET_LOW_FPS = 28;
export const TARGET_HIGH_FPS = 55;

/**
 * How many consecutive readings in the same direction before acting.
 *
 * Two, so that a single stutter — a floor loading, the tab being refocused —
 * does not permanently cost the player their resolution.
 */
export const STREAK_TO_CHANGE = 2;

/**
 * The frame rate below which one level at a time is too slow to be worth waiting for.
 *
 * The controller starts in the middle (see `DEFAULT_QUALITY_LEVEL`), so on a machine that
 * cannot afford even that the honest cost of caution is a few seconds rather than the
 * half-minute it used to be. Two readings per level over the two levels below the start, at
 * one frame every two seconds, is eight seconds of a slideshow instead of twenty -- still long
 * enough to matter, which is why this exists at all.
 *
 * So a reading this far under target gives up two levels per change instead of one.
 * The debounce is unchanged: it still takes `STREAK_TO_CHANGE` consecutive readings,
 * because a single slow frame is a floor loading and not a verdict on the machine.
 */
export const PANIC_FPS = TARGET_LOW_FPS / 4;

export interface QualityState {
  /** Index into QUALITY_LEVELS. */
  level: number;
  /**
   * Consecutive readings in the current direction. Negative is "too slow",
   * positive is "spare capacity", zero is "about right".
   */
  streak: number;
  /** Times the level has actually moved, for the HUD and for tests. */
  changes: number;
}

export function initialQuality(): QualityState {
  return { level: DEFAULT_QUALITY_LEVEL, streak: 0, changes: 0 };
}

/**
 * Fold one frame-rate reading into the state.
 *
 * A reading of `null` means nothing has been measured yet, and a reading of zero
 * or less means the loop has not completed a frame since the last look. Neither
 * carries information about whether the resolution is affordable, and treating
 * "no frames" as "too slow" is exactly the mistake that would drop a player to
 * the blurriest setting during a load.
 */
export function evaluateQuality(state: QualityState, fps: number | null): QualityState {
  if (fps === null || !Number.isFinite(fps) || fps <= 0) {
    return { ...state, streak: 0 };
  }

  if (fps < TARGET_LOW_FPS) {
    const streak = Math.min(0, state.streak) - 1;
    if (-streak >= STREAK_TO_CHANGE && state.level > 0) {
      // Halve the wait on a machine that is failing badly rather than marginally.
      const step = fps < PANIC_FPS ? 2 : 1;
      return {
        level: Math.max(0, state.level - step),
        streak: 0,
        changes: state.changes + 1,
      };
    }
    return { ...state, streak };
  }

  if (fps > TARGET_HIGH_FPS) {
    const streak = Math.max(0, state.streak) + 1;
    if (streak >= STREAK_TO_CHANGE && state.level < QUALITY_LEVELS.length - 1) {
      return { level: state.level + 1, streak: 0, changes: state.changes + 1 };
    }
    return { ...state, streak };
  }

  return { ...state, streak: 0 };
}

/** The render-resolution multiplier for a level. */
export function pixelRatioForLevel(level: number): number {
  const clamped = Math.min(QUALITY_LEVELS.length - 1, Math.max(0, Math.floor(level)));
  return QUALITY_LEVELS[clamped];
}

/**
 * A note on the two levers that are not here, and the one that is.
 *
 * `sort.minIntervalMs` was added as a second degradation axis, on the reasoning
 * that the bottleneck is the CPU sort rather than fill rate. `tools/bench-sort.mjs`
 * removed that reasoning: 335 frames across four settings gave 2134 / 2072 / 2052 /
 * 2088 ms per frame, a 2-4% spread that is noise, and the reason is structural --
 *
 *   the option caps how often the sort may run, but a renderer already sorts once
 *   per frame, and on a machine slow enough to need help the frame time is far
 *   longer than any sane interval. At 0.5 fps the frame is 2000 ms; a 24 ms cap
 *   never binds. It can only take effect above 1/interval frames per second, which
 *   is exactly the machine that does not need it.
 *
 * Then `tools/bench-render.mjs` established that resolution -- this file's only
 * lever -- is the right one, and by how much:
 *
 *   1.00x with the splats drawn   2017 ms   the reconstruction is 99% of the frame
 *   0.55x with the splats drawn   1400 ms   31% off
 *   0.40x with the splats drawn   1333 ms   34% off
 *   1.00x with the splats hidden    17 ms   everything else in the frame
 *
 * So the controller degrades resolution and only resolution, and the curve says the
 * floor is placed correctly: 0.55x already recovers 31% of a possible 34%, so
 * another step down buys 5% and costs a lot of sharpness.
 */

/**
 * A short label for the HUD.
 *
 * Stated as the multiplier rather than as "low / medium / high", because the
 * number is the thing a player can act on when they report a problem.
 */
export function qualityLabel(level: number): string {
  const ratio = pixelRatioForLevel(level);
  return `${ratio.toFixed(2)}x`;
}

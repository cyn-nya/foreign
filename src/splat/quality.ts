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

/** The level a player starts on, before anything has been measured. */
export const DEFAULT_QUALITY_LEVEL = QUALITY_LEVELS.length - 1;

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
      return { level: state.level - 1, streak: 0, changes: state.changes + 1 };
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
 * A short label for the HUD.
 *
 * Stated as the multiplier rather than as "low / medium / high", because the
 * number is the thing a player can act on when they report a problem.
 */
export function qualityLabel(level: number): string {
  const ratio = pixelRatioForLevel(level);
  return `${ratio.toFixed(2)}x`;
}

/**
 * What the frame rate actually is.
 *
 * This was inlined twice — once to paint the F3 line and once to be readable by
 * the acceptance harness — and the same subtle mistake was in both copies. It is
 * a pure function here for the ordinary reason (it can be tested) and for the
 * specific one: this rule has now been got wrong three times, and each time the
 * check that caught it was looking at a different symptom.
 */

export interface FrameSummary {
  /** Timestamps within the window. */
  samples: number;
  /** Gaps the rate was computed from. */
  intervals: number;
  /** The span the rate was divided by. */
  spanMs: number;
  /** How far back the recorded history goes at all. */
  historyMs: number;
  /** Frames per second, or 0 when there is not enough to say. */
  fps: number;
  /** The slowest gap in the window. */
  worstMs: number;
}

/** A gap this much larger than the window is a stall, not a frame time. */
const STALL_FRACTION = 1 / 8;

/**
 * Turn a list of frame timestamps into a frame rate.
 *
 * Timestamps rather than deltas, and the window is in milliseconds. A 60-frame
 * window sounds like "the last second" only while the loop is fast: at two frames
 * per second it spans half a minute, so the counter spent a stalled floor
 * reporting the frame rate from before the floor loaded.
 */
export function summariseFrames(
  frameTimes: readonly number[],
  windowMs: number,
): FrameSummary {
  const empty: FrameSummary = {
    samples: 0,
    intervals: 0,
    spanMs: 0,
    historyMs: 0,
    fps: 0,
    worstMs: 0,
  };
  if (frameTimes.length < 2) {
    return { ...empty, samples: frameTimes.length };
  }

  const newest = frameTimes[frameTimes.length - 1];
  const from = newest - windowMs;
  const recent = frameTimes.filter((t) => t >= from);

  let worst = 0;
  for (let i = 1; i < recent.length; i++) worst = Math.max(worst, recent[i] - recent[i - 1]);

  const historyMs = newest - frameTimes[0];

  /**
   * A stall is not an average.
   *
   * `intervals / span` reads plausibly and lies whenever the frames in the window
   * are not spread evenly across it — which is the only case anyone looks at the
   * number. Three times, each one surviving the fix for the last:
   *
   *   1. Two frames 49 ms apart at the end of a five-second window, nothing
   *      before them: 20.4 fps for a loop doing 0.4 fps.
   *   2. A load burst of 32 frames in 783 ms then a 3834 ms stall with one frame
   *      after it: 7.15 fps for a loop doing 0.2 fps, because the history was
   *      4.6 s — just under the window — so the whole history became the divisor.
   *   3. A burst of 122 frames just before the window opened, then two frames
   *      across the next five seconds: 24.6 fps for a loop doing 0.4 fps. Fix 2
   *      only looked at the *last* gap, and here the stall arrived in pieces.
   *
   * The rule that covers all three: **the frames after the last stall are the
   * current run, and only those describe now.** A stall is a gap more than an
   * eighth of the window, which is far outside any plausible frame time at a
   * playable rate and far inside the short span a burst occupies.
   */
  const stallMs = windowMs * STALL_FRACTION;
  let runStart = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] - recent[i - 1] > stallMs) runStart = i;
  }

  if (runStart > 0) {
    const run = recent.slice(runStart);
    // A single frame after the stall still dates the stall: the gap that ended
    // the previous run is the only evidence there is about the current one.
    const spanMs =
      run.length >= 2 ? run[run.length - 1] - run[0] : recent[runStart] - recent[runStart - 1];
    const intervals = run.length >= 2 ? run.length - 1 : 1;
    return {
      samples: recent.length,
      intervals,
      spanMs,
      historyMs,
      fps: spanMs > 0 ? intervals / (spanMs / 1000) : 0,
      worstMs: worst,
    };
  }

  if (recent.length < 2) {
    return {
      samples: recent.length,
      intervals: 0,
      spanMs: windowMs,
      historyMs,
      fps: 0,
      worstMs: worst,
    };
  }

  // The window is the full span, or the whole history while it is still shorter
  // than one window — otherwise the first second after load reads as a spike.
  const oldest = Math.max(frameTimes[0], from);
  const spanMs = newest - oldest;
  // Two frames can share a timestamp when the browser coalesces callbacks, which
  // would otherwise make the reported rate infinite. Reporting no intervals keeps
  // the summary consistent: `fps` is always `intervals / spanMs`.
  const intervals = spanMs > 0 ? recent.length - 1 : 0;
  return {
    samples: recent.length,
    intervals,
    spanMs,
    historyMs,
    fps: spanMs > 0 ? intervals / (spanMs / 1000) : 0,
    worstMs: worst,
  };
}

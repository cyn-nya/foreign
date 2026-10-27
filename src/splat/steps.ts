/**
 * When a foot hits the floor.
 *
 * A footstep is not a timer. It is a distance, and the reason is the same reason the drone
 * is a continuous value rather than a clip: a player who stops moving must stop making
 * noise, and a player who crawls must not sound like they are running. A fixed interval
 * does the opposite — it keeps clicking while the player stands still, or falls silent
 * while they cross the room quickly.
 *
 * Pure and separate from the audio graph so it can be tested. The failure this guards
 * against is not audible in a screenshot and not visible in a frame time: it is a game that
 * clicks at you while you are holding your breath, which is the one thing a horror game
 * must not do.
 */

/** The distance one stride covers, in metres. */
export const STRIDE_M = 0.78;

/** The fastest a step may follow another, in seconds. */
export const MIN_STEP_INTERVAL_S = 0.22;

export interface StepState {
  /** Distance walked since the last footstep. */
  pending: number;
  /** Seconds since the last footstep. */
  since: number;
  /** Total footsteps taken. */
  count: number;
}

export function initialSteps(): StepState {
  return { pending: 0, since: Number.POSITIVE_INFINITY, count: 0 };
}

/**
 * Fold one frame's movement into the state.
 *
 * `distance` is how far the player moved this frame, in metres; `dt` is the frame time.
 * Returns a new state and whether this frame produced a footstep, rather than mutating —
 * so the caller cannot half-apply a step.
 *
 * The interval floor matters more than it looks. At a walking pace a stride is about a
 * third of a second, but a player who sprints across a room in a single long frame would
 * otherwise fire several steps at once, which reads as a stutter rather than as running.
 */
export function advanceSteps(
  state: StepState,
  distance: number,
  dt: number,
): { state: StepState; stepped: boolean } {
  // A frame with no movement still ages the interval, so the floor cannot be gamed by
  // standing still and then moving.
  const since = state.since + (Number.isFinite(dt) && dt > 0 ? dt : 0);
  const pending = state.pending + (Number.isFinite(distance) && distance > 0 ? distance : 0);

  if (pending < STRIDE_M || since < MIN_STEP_INTERVAL_S) {
    return { state: { pending, since, count: state.count }, stepped: false };
  }

  // Carry the remainder rather than resetting to zero, or a long frame would silently
  // discard the distance past the stride and the step rate would depend on the frame rate.
  return {
    state: { pending: pending - STRIDE_M, since: 0, count: state.count + 1 },
    stepped: true,
  };
}

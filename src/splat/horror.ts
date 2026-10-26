/**
 * How the run gets worse as it goes down.
 *
 * Everything here is a pure function of the floor, so the shape of the descent
 * can be tested without a browser and without waiting for floor seven. The three
 * curves are the whole design: the room darkens, the torch narrows, and the
 * quiet between frights shortens.
 *
 * The fear is meant to come from not being able to see rather than from what is
 * shown. Nothing here is gore, and the scares are sudden rather than graphic —
 * which is both more frightening and the version that survives a review.
 */

/** Floors past this are as dark as the game ever gets. */
export const MAX_DARKNESS_FLOOR = 8;
export const MAX_DARKNESS = 0.86;
export const MIN_DARKNESS = 0.18;
/** How much darker each floor is than the last. */
export const DARKNESS_STEP = 0.1;

/**
 * Opacity of the darkness overlay on a floor, 0..1.
 *
 * Never reaches 1: the player has to be able to make out the room's shape or the
 * game stops being a search and becomes guessing. The cap is what keeps it a
 * horror game instead of a black screen.
 */
export function darknessForFloor(floor: number): number {
  const step = Math.max(0, floor - 1);
  return Math.min(MAX_DARKNESS, MIN_DARKNESS + step * DARKNESS_STEP);
}

/** The torch's radius, as a fraction of the screen's shorter side. */
export const TORCH_RADIUS_NEAR = 0.62;
export const TORCH_RADIUS_FAR = 0.26;
export const TORCH_STEP = 0.05;

/**
 * How wide the torch beam is on a floor.
 *
 * Narrowing the beam does more for dread than darkening the room, because it is
 * the player's only tool and it visibly stops being enough.
 */
export function torchRadiusForFloor(floor: number): number {
  const step = Math.max(0, floor - 1);
  return Math.max(TORCH_RADIUS_FAR, TORCH_RADIUS_NEAR - step * TORCH_STEP);
}

/**
 * How far the beam wanders, 0..1.
 *
 * A torch that holds perfectly still reads as a vignette. Flicker is what makes
 * it a torch, and it tightens with depth so the late floors feel like the light
 * is failing.
 */
export function torchFlickerForFloor(floor: number): number {
  const step = Math.max(0, floor - 1);
  return Math.min(1, 0.25 + step * 0.11);
}

/** The range an ambient scare's delay is drawn from, in seconds. */
export function scareDelayRange(
  floor: number,
): { min: number; max: number } {
  const step = Math.max(0, Math.min(MAX_DARKNESS_FLOOR - 1, floor - 1));
  const span = 1 - step / (MAX_DARKNESS_FLOOR - 1);
  return { min: 9 + span * 16, max: 20 + span * 40 };
}

/**
 * Seconds until the next ambient scare.
 *
 * Draws from `scareDelayRange`, so an unlit lower floor is quiet for a long time
 * and floor eight is never quiet for more than twenty seconds.
 */
export function nextScareDelay(rng: () => number, floor: number): number {
  const { min, max } = scareDelayRange(floor);
  return min + rng() * (max - min);
}

/** Which of the pre-loaded horror faces a scare should use. */
export const SCARE_FACES = ['face', 'eye', 'teeth', 'hand', 'doll', 'figure'] as const;
export type ScareFace = (typeof SCARE_FACES)[number];

/**
 * Pick a scare's face, avoiding an immediate repeat.
 *
 * The same face twice in a row reads as a bug rather than as a fright.
 */
export function pickScareFace(rng: () => number, previous: ScareFace | null): ScareFace {
  const pool = SCARE_FACES.filter((face) => face !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

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
/**
 * How a fright is delivered.
 *
 * Six faces and one effect is still one scare. Horror lives on surprise, and the
 * fifth identical flash is not frightening -- it is furniture. These vary the
 * *shape* of the event rather than its content, which is what stops the player
 * learning to wait it out:
 *
 *   flash    a face at the periphery, gone before it resolves (the original)
 *   lunge    the same face arriving over half a second instead of a tenth of one
 *   blackout no face at all: the screen cuts and the torch dies for a moment
 *   double   two faces, the second after a beat, so the relief is the setup
 *
 * `blackout` deliberately shows nothing. The anticipation of a second thing is
 * worse than any picture, and it costs nothing to draw.
 */
export const SCARE_KINDS = ['flash', 'lunge', 'blackout', 'double'] as const;

/**
 * The charge: something crosses the room at you and you have to put it down.
 *
 * Separate from `SCARE_KINDS` on purpose. Those are picked at random and end on a
 * timer; this one ends when the player clicks, and if it were in that list the random
 * picker would eventually fire one that nothing ever resolves.
 */

/** Floor the charge first appears on. Floor 1 and 2 teach looking, not reacting. */
export const CHARGE_FIRST_FLOOR = 3;

/**
 * How long the player has to react, in ms, by floor.
 *
 * Floor 3 gives 2.2 s -- long enough that the right response is obvious once it has
 * happened. Floor 8 gives 1.0 s, which is about as short as this can be and still be a
 * response rather than a formality. Below that it stops being a test of the player.
 */
export function chargeWindowForFloor(floor: number): number {
  const steps = Math.max(0, floor - CHARGE_FIRST_FLOOR);
  return Math.max(1000, 2200 - steps * 200);
}

/**
 * Chance that a scheduled fright is a charge instead of a scream, by floor.
 *
 * It starts at a third: frequent enough on the first floor that carries it that a
 * player meets it more than once, rare enough that the ordinary frights still set the
 * rhythm. It saturates rather than reaching 1, because a floor made only of charges
 * has no quiet in it and the quiet is what makes them land.
 */
export function chargeChanceForFloor(floor: number): number {
  if (floor < CHARGE_FIRST_FLOOR) return 0;
  return Math.min(0.6, 0.33 + (floor - CHARGE_FIRST_FLOOR) * 0.05);
}

/**
 * How many charge models one floor may use.
 *
 * Two, not seven. The whole charge set is 45 MB, against a 63 MB reconstruction -- so
 * preloading all of it would nearly double what a player waits for, to show at most two of
 * them, and it would do it while they are still on floor one, which has no charges at all.
 * Two is enough that a player cannot predict which is coming, which is the only reason to
 * have more than one.
 */
export const CHARGE_MODELS_PER_FLOOR = 2;

/**
 * Which charge models a floor preloads.
 *
 * Deterministic in the floor, for the same reason the floors themselves are: the same floor
 * number has to be the same floor, or a report about "floor five" means nothing. Rotated
 * through the sorted keys rather than drawn at random, so every model is used by some floor
 * and a player who reaches floor eight has met all of them.
 *
 * Empty below `CHARGE_FIRST_FLOOR`: those floors teach looking, and a 45 MB download for a
 * mechanic that cannot fire is the kind of thing that is only ever noticed as "the game is
 * slow".
 */
export function chargeModelsForFloor(floor: number, keys: readonly string[]): string[] {
  if (floor < CHARGE_FIRST_FLOOR || keys.length === 0) return [];
  const sorted = [...keys].sort();
  const count = Math.min(CHARGE_MODELS_PER_FLOOR, sorted.length);
  // The floor number itself, not a multiple of it. `floor * 7 % 7` is zero on every floor
  // when there are seven models -- so every floor would load the same two and the other
  // five would never be seen by anyone, having each cost a Lux3D task to generate. The
  // unit test that wanted every model used by some floor is what caught it.
  const offset = ((floor % sorted.length) + sorted.length) % sorted.length;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(sorted[(offset + i) % sorted.length]);
  return out;
}
export type ScareKind = (typeof SCARE_KINDS)[number];

/** How long each kind holds the screen, in milliseconds. */
export const SCARE_KIND_MS: Record<ScareKind, number> = {
  flash: 150,
  lunge: 420,
  blackout: 620,
  // Two flashes and the gap between them.
  double: 150 + 210 + 150,
};

/** The intensity at which the deeper kinds start appearing. */
export const LUNGE_FROM = 0.55;
export const BLACKOUT_FROM = 0.72;

/**
 * Which kinds a fright at this intensity may use.
 *
 * Escalating the *repertoire* rather than only the volume is what makes a deep
 * floor feel different rather than merely louder. A shallow floor cannot black
 * out the room, because a player who has not yet learnt the room would read a
 * blackout as a bug rather than as a threat.
 */
export function scareKindsFor(intensity: number): ScareKind[] {
  const kinds: ScareKind[] = ['flash', 'lunge'];
  if (intensity < LUNGE_FROM) return ['flash'];
  if (intensity < BLACKOUT_FROM) return kinds;
  return [...kinds, 'blackout', 'double'];
}

/**
 * Pick a fright, avoiding an immediate repeat of the same kind.
 *
 * The same reasoning as `pickScareFace`: two identical events in a row read as a
 * bug rather than as dread. With only one kind available the repeat is
 * unavoidable and is returned rather than being an error.
 */
export function pickScareKind(
  rng: () => number,
  intensity: number,
  previous: ScareKind | null,
): ScareKind {
  const pool = scareKindsFor(intensity);
  if (pool.length <= 1) return pool[0] ?? 'flash';
  const filtered = pool.filter((kind) => kind !== previous);
  const choices = filtered.length > 0 ? filtered : pool;
  return choices[Math.floor(rng() * choices.length) % choices.length];
}

export function pickScareFace(rng: () => number, previous: ScareFace | null): ScareFace {
  const pool = SCARE_FACES.filter((face) => face !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

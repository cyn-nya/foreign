/**
 * A slot holds one thing.
 *
 * `judgeMark` decides by slot id alone:
 *
 *     const hit = plan.anomalies.find((a) => a.slotId === slotId);
 *     if (!hit) return { result: 'miss' };
 *
 * It never asks whether the crosshair reached the anomaly's own node, because a slot was
 * assumed to hold exactly one object. If a bystander ever shares a slot with an anomaly,
 * marking the innocent object in that slot scores a hit -- the game congratulates the
 * player for marking a chair, which is the one judgement the whole design rests on.
 *
 * The acceptance run reported it, with the crosshair and the judged slot agreeing:
 *
 *     3 bystanders, crosshair on fx_room_07 -> judged fx_room_07 = hit
 *
 * Three bystanders rules out floor 1, which places exactly one -- so this is the multi
 * floor path, and it is searched here across every shape the game can ask for rather than
 * only the default one.
 */
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/game/rules.ts';
import { ROOM_FLOOR_OPTIONS } from '../src/splat/roomAnchors.ts';
import type { AnomalyKind } from '../src/game/types.ts';

const KINDS: AnomalyKind[] = ['intrude', 'stare', 'shift', 'warp', 'twin', 'invert', 'swarm'];

function clashesFor(plan: ReturnType<typeof generateFloor>): string[] {
  const found: string[] = [];
  const anomalySlots = new Map<string, number>();
  for (const anomaly of plan.anomalies) {
    anomalySlots.set(anomaly.slotId, (anomalySlots.get(anomaly.slotId) ?? 0) + 1);
  }
  for (const [slot, count] of anomalySlots) {
    if (count > 1) found.push(`two anomalies in ${slot}`);
  }
  for (const bystander of plan.bystanders) {
    if (anomalySlots.has(bystander.slotId)) found.push(`bystander in anomaly slot ${bystander.slotId}`);
  }
  return found;
}

describe('slot ownership', () => {
  it('never puts two objects in one slot, for any floor, seed or kind set', () => {
    const clashes: string[] = [];
    for (let floor = 1; floor <= 8; floor++) {
      for (let seed = 1; seed <= 60; seed++) {
        const shapes: Array<{ label: string; opts: Parameters<typeof generateFloor>[2] }> = [
          { label: 'default', opts: {} },
          // The reconstruction is a different game: `foreignOnly` swaps the anchor list and
          // picks different builders, so a search that only covers the procedural room
          // proves nothing about the build that ships. The first version of this test made
          // exactly that mistake and passed while the shipped path was clashing.
          { label: 'room default', opts: ROOM_FLOOR_OPTIONS },
          // The acceptance harness forces a single kind onto a floor, which changes which
          // builder runs and therefore which anchors get consumed.
          ...KINDS.map((kind) => ({ label: `room kinds=[${kind}]`, opts: { ...ROOM_FLOOR_OPTIONS, kinds: [kind] } })),
          { label: 'room kinds=all', opts: { ...ROOM_FLOOR_OPTIONS, kinds: KINDS } },
          ...KINDS.map((kind) => ({ label: `kinds=[${kind}]`, opts: { kinds: [kind] } })),
          { label: 'kinds=all', opts: { kinds: KINDS } },
        ];
        for (const shape of shapes) {
          const plan = generateFloor(floor, floor * 7919 + seed, shape.opts);
          for (const clash of clashesFor(plan)) {
            clashes.push(`floor ${floor} seed ${floor * 7919 + seed} ${shape.label}: ${clash}`);
          }
        }
      }
    }
    const unique = [...new Set(clashes)];
    expect(unique.slice(0, 20), `${unique.length} slot clashes, first 20:\n  ${unique.join('\n  ')}`).toEqual([]);
  });
});

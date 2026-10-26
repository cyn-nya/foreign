import { describe, expect, it } from 'vitest';
import { summariseFrames } from '../src/splat/framerate.ts';

const WINDOW = 5_000;

/** Evenly spaced timestamps ending at `end`, `count` of them, `gapMs` apart. */
function even(count: number, gapMs: number, end = 100_000): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(end - i * gapMs);
  return out;
}

describe('the frame-rate counter', () => {
  it('reports a steady rate correctly', () => {
    // 100 frames at 60 fps: one every 16.67 ms.
    const s = summariseFrames(even(100, 1000 / 60), WINDOW);
    expect(s.fps).toBeGreaterThan(59);
    expect(s.fps).toBeLessThan(61);
  });

  it('says nothing when there is nothing to say', () => {
    expect(summariseFrames([], WINDOW).fps).toBe(0);
    expect(summariseFrames([1234], WINDOW).fps).toBe(0);
  });

  it('describes the last five seconds, not the whole session', () => {
    // A long fast history, then a slow tail: the answer is the tail.
    const burst = even(200, 16, 100_000);
    const tail = [106_000, 108_000, 110_000];
    const s = summariseFrames([...burst, ...tail], WINDOW);
    // Three frames across six seconds cannot be 60 fps.
    expect(s.fps).toBeLessThan(5);
  });

  // The first way this was wrong, kept as a test so it cannot come back.
  //
  // My first version of this test used just [100000, 100049] and asserted a low
  // rate — and it failed, correctly. Two frames 49 ms apart with no other history
  // is a loop that has existed for 49 ms, and 20.4 fps is the truth about it. The
  // bug the comment describes needs older history: two frames at the end of a
  // window whose earlier frames have aged out, where dividing by the gap between
  // the last two would report the rate of two frames as if it were the rate of
  // the loop.
  it('does not report a healthy rate for two frames at the end of a window', () => {
    const aged = even(50, 16, 94_000);
    const s = summariseFrames([...aged, 100_000, 100_049], WINDOW);
    // One interval inside a five-second window is 0.2 fps, not 1/0.049.
    expect(s.fps).toBeLessThan(1);
  });

  it('is honest about a loop that has only just produced two frames', () => {
    // The other side of the same coin: with no history at all there is no window
    // to divide by, and the instantaneous rate is the only true answer.
    const s = summariseFrames([100_000, 100_049], WINDOW);
    expect(s.fps).toBeGreaterThan(15);
  });

  // The second way, which survived the fix for the first: the history was just
  // under the window, so the whole history became the divisor and a stall was
  // averaged against a finished burst.
  it('does not average a stall against a burst that already finished', () => {
    // 32 frames in 783 ms, then a 3834 ms stall, then one frame.
    const burst: number[] = [];
    for (let i = 0; i < 32; i++) burst.push(100_000 + i * (783 / 31));
    const times = [...burst, 100_783 + 3_834];
    const s = summariseFrames(times, WINDOW);
    // Dividing 33 intervals by the 4617 ms history says 7.15 fps for a loop that
    // has just taken 3.8 seconds over one frame.
    expect(s.fps).toBeLessThan(1);
    expect(1000 / s.fps).toBeCloseTo(3_834, 0);
    // And the summary has to be internally consistent: whoever reads `fps` must
    // get the same number by dividing the intervals it reports by the span it
    // reports. Reporting the window's intervals against a single gap is how this
    // said 47/2.87 = 16.4 fps while stating 0.35.
    expect(s.intervals / (s.spanMs / 1000)).toBeCloseTo(s.fps, 6);
    // `samples` is still the count in the window, which is what the HUD prints.
    expect(s.samples).toBeGreaterThan(2);
  });

  // The third way, which survived the fix for the first two. Fix 2 only looked at
  // the *last* gap, and here the stall arrived in pieces: a burst of fast frames
  // just before the window opened, then two frames spread across the whole five
  // seconds. Every individual gap is under half the window, so "is the last gap
  // large" says no, and the counter reported 24.6 fps for a loop doing 0.4 fps.
  it('does not let a burst inside the window hide a stall that arrives in pieces', () => {
    const times: number[] = [];
    // 122 frames in ~60 ms, ending right before the window opens.
    for (let i = 0; i < 122; i++) times.push(100_000 + i * 0.5);
    // Then two frames across the next five seconds.
    times.push(100_061 + 2_500, 100_061 + 5_000);
    const s = summariseFrames(times, WINDOW);
    // Counting the burst in gives 123 intervals over 5 s = 24.6 fps.
    expect(s.fps).toBeLessThan(1);
    expect(s.intervals / (s.spanMs / 1000)).toBeCloseTo(s.fps, 6);
  });

  // The fourth way, which the fix for the third introduced. Trimming to the run
  // threw away the seconds that made the burst a burst: nine frames across five
  // seconds, the last three inside 116 ms, reported 17.14 fps for a loop doing
  // 1.8. A run may not claim more than the window supports.
  it('does not let a short burst inside a stalled window outbid the window', () => {
    const times: number[] = [];
    // Six frames spread across the first 4.9 seconds...
    for (let i = 0; i < 6; i++) times.push(100_000 + i * 960);
    // ...then three arriving back to back.
    const base = 100_000 + 4_800;
    for (let i = 0; i < 3; i++) times.push(base + i * 40);
    const s = summariseFrames(times, WINDOW);
    // The burst is 2 intervals over 80 ms, which is 25 fps on its own. The loop
    // is not doing that and the counter must not say it is.
    expect(s.fps).toBeLessThan(3);
    expect(s.intervals / (s.spanMs / 1000)).toBeCloseTo(s.fps, 6);
  });

  it('does not mistake an ordinary slow loop for a stall', () => {
    // Gaps of 1.6 s each are a genuinely slow but *even* loop. Trimming to the
    // last run would throw away frames that are all equally valid.
    const times = [100_000, 101_600, 103_200, 104_800, 106_400];
    const s = summariseFrames(times, WINDOW);
    // Four intervals across 6.4 s, of which the last 5 s holds three.
    expect(s.fps).toBeGreaterThan(0.3);
    expect(s.fps).toBeLessThan(2);
    expect(s.intervals / (s.spanMs / 1000)).toBeCloseTo(s.fps, 6);
  });

  it('still reports the slowest gap, so the stall is visible either way', () => {
    const burst: number[] = [];
    for (let i = 0; i < 32; i++) burst.push(100_000 + i * (783 / 31));
    const s = summariseFrames([...burst, 100_783 + 3_834], WINDOW);
    expect(s.worstMs).toBeCloseTo(3_834, 0);
  });

  it('counts only the frames inside the window', () => {
    // 40 frames at 60 fps is 650 ms; a window of 5 s holds all of them.
    const all = even(40, 1000 / 60);
    expect(summariseFrames(all, WINDOW).samples).toBe(40);
    // A 200 ms window holds about a dozen.
    const narrow = summariseFrames(all, 200);
    expect(narrow.samples).toBeLessThan(all.length);
    expect(narrow.samples).toBeGreaterThan(1);
  });

  it('never returns a negative or non-finite rate', () => {
    for (const times of [[0, 0], [5, 5, 5], [0, 1], even(10, 0)]) {
      const s = summariseFrames(times, WINDOW);
      expect(Number.isFinite(s.fps)).toBe(true);
      expect(s.fps).toBeGreaterThanOrEqual(0);
    }
  });

  // Every branch has to agree with itself: whoever reads `fps` must get the same
  // number by dividing the intervals it reports by the span it reports. Both
  // previous bugs showed up here before they showed up anywhere else.
  it('is always internally consistent', () => {
    const burst: number[] = [];
    for (let i = 0; i < 32; i++) burst.push(100_000 + i * (783 / 31));
    const cases = [
      [],
      [1],
      [0, 0],
      [100_000, 100_049],
      [...burst, 100_783 + 3_834],
      [...even(50, 16, 94_000), 100_000, 100_049],
      even(100, 1000 / 60),
      even(40, 1000 / 60),
    ];
    for (const times of cases) {
      const s = summariseFrames(times, WINDOW);
      if (s.spanMs <= 0) {
        expect(s.intervals).toBe(0);
        expect(s.fps).toBe(0);
        continue;
      }
      expect(s.intervals / (s.spanMs / 1000)).toBeCloseTo(s.fps, 6);
    }
  });
});

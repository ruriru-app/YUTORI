import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function buildDistribution(...args) {
  const context = vm.createContext({});
  const source = await readFile(new URL("../assets/yutori-score-distribution.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  assert.equal(typeof context.YutoriScoreDistribution?.buildDistribution, "function");
  // Convert cross-realm objects without rounding or JSON's NaN coercion.
  return structuredClone(context.YutoriScoreDistribution.buildDistribution(...args));
}

// Catches wrong averaging, boundary ownership, maximum overflow and missing empty bands.
test("builds ten bands and includes the maximum in the final band", async () => {
  assert.deepEqual(await buildDistribution([0, 10, 50, 100], 100, 100), {
    maximum: 100, count: 4, average: 40,
    bins: [
      { from: 0, to: 10, count: 1 }, { from: 10, to: 20, count: 1 },
      { from: 20, to: 30, count: 0 }, { from: 30, to: 40, count: 0 },
      { from: 40, to: 50, count: 0 }, { from: 50, to: 60, count: 1 },
      { from: 60, to: 70, count: 0 }, { from: 70, to: 80, count: 0 },
      { from: 80, to: 90, count: 0 }, { from: 90, to: 100, count: 1 }
    ], ownScore: 100, ownBin: 9
  });
});

// Catches integerizing scores, dropping fractional boundaries or moving near-boundary values up.
for (const fixture of [
  { maximum: 10, scores: [0, 5.999999, 6, 10], ownScore: 6, average: 5.49999975 },
  { maximum: 2.5, scores: [0, 1.499999, 1.5, 2.5], ownScore: 1.5, average: 1.37499975 },
  { maximum: .7, scores: [0, .419999, .42, .7], ownScore: .42, average: .38499975 }
]) test(`preserves decimal scores and boundary ownership with maximum ${fixture.maximum}`, async () => {
  const result = await buildDistribution(fixture.scores, fixture.maximum, fixture.ownScore);
  assert.equal(result.maximum, fixture.maximum);
  assert.equal(result.count, 4);
  assert.ok(Math.abs(result.average - fixture.average) < 1e-14);
  assert.deepEqual(result.bins.map(bin => bin.count), [1, 0, 0, 0, 0, 1, 1, 0, 0, 1]);
  assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.equal(result.bins[0].from, 0);
  assert.equal(result.bins[9].to, fixture.maximum);
  assert.equal(result.ownScore, fixture.ownScore);
  assert.equal(result.ownBin, 6);
});

// Catches treating zero as missing or double-counting tied scores.
for (const fixture of [
  { scores: [0, 0, 0], ownScore: 0, count: 3, average: 0, counts: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0], ownBin: 0 },
  { scores: [25], ownScore: 25, count: 1, average: 25, counts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0], ownBin: 2 },
  { scores: [25, 25], ownScore: 25, count: 2, average: 25, counts: [0, 0, 2, 0, 0, 0, 0, 0, 0, 0], ownBin: 2 }
]) test(`counts ${fixture.scores.length} zero or tied scores without a missing marker`, async () => {
  const result = await buildDistribution(fixture.scores, 100, fixture.ownScore);
  assert.equal(result.count, fixture.count);
  assert.equal(result.average, fixture.average);
  assert.deepEqual(result.bins.map(bin => bin.count), fixture.counts);
  assert.equal(result.ownScore, fixture.ownScore);
  assert.equal(result.ownBin, fixture.ownBin);
});

// Catches coercing malformed scores or allowing out-of-range scores into statistics.
test("only aggregates finite numeric scores within the maximum", async () => {
  const result = await buildDistribution([NaN, Infinity, -Infinity, "50", null, -1, 101, 0, 25.5, 100], 100);
  assert.equal(result.count, 3);
  assert.equal(result.average, 125.5 / 3);
  assert.deepEqual(result.bins.map(bin => bin.count), [1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(result.ownScore, null);
  assert.equal(result.ownBin, null);
});

// Catches showing a marker for an invalid own score while preserving class statistics.
test("invalid own scores never produce markers", async () => {
  for (const ownScore of [NaN, Infinity, -Infinity, "50", null, -1, 101]) {
    const result = await buildDistribution([50], 100, ownScore);
    assert.equal(result.count, 1);
    assert.equal(result.average, 50);
    assert.equal(result.ownScore, null);
    assert.equal(result.ownBin, null);
  }
});

// Catches fabricated averages or markers when no valid class scores exist.
test("empty or entirely invalid input keeps empty bands but no average or marker", async () => {
  for (const scores of [[], [NaN, Infinity, "0", null, -1, 101]]) {
    const result = await buildDistribution(scores, 100, 50);
    assert.equal(result.maximum, 100);
    assert.equal(result.count, 0);
    assert.equal(result.average, null);
    assert.deepEqual(result.bins.map(bin => bin.count), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(result.ownScore, null);
    assert.equal(result.ownBin, null);
  }
});

// Catches division by zero, malformed maximum coercion and non-finite result fields.
test("invalid maximum produces a completely empty distribution", async () => {
  for (const maximum of [0, -100, NaN, Infinity, -Infinity, "100", null]) {
    assert.deepEqual(await buildDistribution([0, 50, 100], maximum, 50), {
      maximum: null, count: 0, average: null, bins: [], ownScore: null, ownBin: null
    });
  }
});

// Catches in-place sorting, filtering or other modification of caller-owned input.
test("does not mutate the input array", async () => {
  const scores = Object.freeze([100, NaN, 10, 0, null, 50]);
  const before = [...scores];
  const result = await buildDistribution(scores, 100, 10);
  assert.deepEqual(scores, before);
  assert.equal(result.count, 4);
  assert.equal(result.average, 40);
});

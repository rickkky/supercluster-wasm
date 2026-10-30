// Shared benchmark utilities: timing and dataset-size configuration.
//
// Used by the baseline runner (bench/baseline/run.js) and the on-demand oracle
// (bench/oracle/oracle-1m.js) so the SIZES env-var parsing and the
// high-resolution timer live in one place.

/**
 * Parse the SIZES env var (comma-separated integers) or fall back to a default.
 * @param {number[]} fallback
 * @returns {number[]}
 */
export function parseSizes(fallback) {
  return process.env.SIZES
    ? process.env.SIZES.split(',').map(Number)
    : fallback;
}

/**
 * Time a synchronous function with nanosecond resolution.
 * @param {() => T} fn
 * @returns {{result: T, ms: number}}
 * @template T
 */
export function timeMs(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

/**
 * Geometric mean of a sample array (ms or ratios). Nulls/non-positive values
 * are skipped; returns null if none remain. Used by every bench runner to
 * aggregate across datasets/sizes — kept here so the three runners (baseline,
 * WASM, compare) share one implementation.
 * @param {(number|null)[]} samples
 * @returns {number|null}
 */
export function geometricMean(samples) {
  const vals = samples.filter((v) => v != null && v > 0);
  if (!vals.length) return null;
  let sum = 0;
  for (const v of vals) sum += Math.log(v);
  return Math.exp(sum / vals.length);
}

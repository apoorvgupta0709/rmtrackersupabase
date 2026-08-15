/**
 * Summation that lands where pandas lands, bit for bit.
 *
 * This matters more than it sounds. A group's total is *published* rounded to three
 * decimals but *sorted* unrounded, so two rows that both read 0.366 can order either way
 * depending on the last bits — and they did: one material held a single row and the next
 * held four, their published tonnages were identical, and the two implementations put them
 * in opposite order.
 *
 * The instinct is to sum more accurately, and that is the wrong move. Compensated
 * summation is *better* than pandas and therefore disagrees with it. What is needed is the
 * same answer, so this reproduces numpy's `pairwise_sum` exactly: a plain left-fold below
 * eight terms, an eight-way unrolled accumulation to 128, and recursive halving above that
 * with the split forced to a multiple of eight.
 */
export function pairwiseSum(values: number[], start = 0, n = values.length): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i += 1) res += values[start + i];
    return res;
  }

  if (n <= 128) {
    let r0 = values[start];
    let r1 = values[start + 1];
    let r2 = values[start + 2];
    let r3 = values[start + 3];
    let r4 = values[start + 4];
    let r5 = values[start + 5];
    let r6 = values[start + 6];
    let r7 = values[start + 7];

    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      r0 += values[start + i];
      r1 += values[start + i + 1];
      r2 += values[start + i + 2];
      r3 += values[start + i + 3];
      r4 += values[start + i + 4];
      r5 += values[start + i + 5];
      r6 += values[start + i + 6];
      r7 += values[start + i + 7];
    }

    // The pairing here is numpy's own, and the grouping of the additions is what decides
    // the low bits — `r0+r1+r2+...` left to right would give a different double.
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i += 1) res += values[start + i];
    return res;
  }

  let half = n >> 1;
  half -= half % 8;
  return pairwiseSum(values, start, half) + pairwiseSum(values, start + half, n - half);
}

/**
 * Summation that lands where a **groupby** lands, which is not where a Series lands.
 *
 * pandas uses two different algorithms and the difference is visible in published figures.
 * `Series.sum()` goes through numpy's pairwise reduction; `groupby().sum()` is Cython code
 * that carries a Kahan compensation term. Over one real nine-row group they give
 * `2.86649999999999982592` and `2.86650000000000027001` — straddling the midpoint, so the
 * column published to three decimals reads 2.866 one way and 2.867 the other.
 *
 * This is classic Kahan exactly as `group_sum` runs it, **including that the compensation
 * is never added back at the end**. Adding it would be more accurate and would once again
 * stop matching.
 */
export function kahanSum(values: number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const y = value - compensation;
    const t = total + y;
    compensation = (t - total) - y;
    total = t;
  }
  return total;
}

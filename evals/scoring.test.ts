import { describe, expect, it } from 'vitest';
import {
  confusionOf,
  declinePass,
  f1,
  groundedPass,
  percentile,
  precision,
  recall,
} from './scoring.js';

describe('scoring', () => {
  it('computes a confusion matrix', () => {
    const c = confusionOf([
      { pred: true, actual: true },
      { pred: true, actual: false },
      { pred: false, actual: true },
      { pred: false, actual: false },
    ]);
    expect(c).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1 });
  });

  it('precision/recall/f1', () => {
    const c = { tp: 8, fp: 2, fn: 4, tn: 6 };
    expect(precision(c)).toBeCloseTo(0.8);
    expect(recall(c)).toBeCloseTo(0.667, 2);
    expect(f1(0.8, 0.667)).toBeCloseTo(0.727, 2);
  });

  it('percentile uses nearest-rank', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentile(xs, 50)).toBe(30);
    expect(percentile(xs, 95)).toBe(50);
    expect(percentile([], 50)).toBe(0);
  });

  it('groundedPass matches facts with boundaries (no substring false positives)', () => {
    expect(groundedPass('Our commission is 5% total', ['5%'])).toBe(true);
    expect(groundedPass('A credit up to $2,500', ['2,500|2500'])).toBe(true);
    expect(groundedPass('Open 9am to 6pm', ['9am|9 am', '6pm|6 pm'])).toBe(true);
    // Boundary/number-aware: a WRONG rate or stray digits must NOT pass.
    expect(groundedPass('Our commission is 15%', ['5%'])).toBe(false);
    expect(groundedPass('Split is 12.5% each', ['2.5%'])).toBe(false);
    expect(groundedPass('Call 555-609 for hours', ['9am|9 am', '6pm|6 pm'])).toBe(false);
    expect(groundedPass(null, ['5%'])).toBe(false);
  });

  it('declinePass: handover/no-answer pass; fabricated $ or % and fallback fail', () => {
    expect(declinePass("I don't have that information", 'knowledge')).toBe(true);
    expect(declinePass('We only serve Marisol Bay County, not Denver.', 'knowledge')).toBe(true);
    expect(declinePass('anything', 'handover')).toBe(true);
    expect(declinePass('The average price is $850,000.', 'knowledge')).toBe(false);
    expect(declinePass('Rates may rise to 7%, but confirm with a lender.', 'knowledge')).toBe(false);
    // A generic fallback is not a deliberate decline.
    expect(declinePass('let me get a team member to help.', 'chitchat', true)).toBe(false);
  });
});

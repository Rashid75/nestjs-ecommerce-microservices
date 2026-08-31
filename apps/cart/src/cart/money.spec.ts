import { lineTotal, sumDecimals, toDecimalString, toMinorUnits } from './money';

/**
 * These tests exist because the naive implementation is subtly wrong in a
 * way that survives casual testing.
 *
 *   Number('19.99') * 3   → 59.96999999999999
 *
 * That is off by a hundredth of a penny. It renders as "59.97" in most
 * formatters, passes a spot check, and only surfaces once totals are summed
 * or compared — by which point the wrong number has been charged.
 */
describe('money', () => {
  describe('toMinorUnits', () => {
    it.each([
      ['0.00', 0],
      ['0.01', 1],
      ['19.99', 1999],
      ['1899.00', 189900],
      ['1899', 189900],
      ['0.5', 50],
      ['-5.25', -525],
    ])('%s → %i', (decimal, expected) => {
      expect(toMinorUnits(decimal)).toBe(expected);
    });
  });

  describe('toDecimalString', () => {
    it.each([
      [0, '0.00'],
      [1, '0.01'],
      [1999, '19.99'],
      [189900, '1899.00'],
      [-525, '-5.25'],
    ])('%i → %s', (minor, expected) => {
      expect(toDecimalString(minor)).toBe(expected);
    });
  });

  describe('lineTotal', () => {
    it('is exact where floating point is not', () => {
      // A genuinely lossy case: 16.08 * 3 is 48.239999999999995 as a double.
      expect(lineTotal('16.08', 3)).toBe('48.24');
      expect(Number('16.08') * 3).not.toBe(48.24);
    });

    it('is exact for values where floating point HAPPENS to be exact too', () => {
      // 19.99 * 3 lands exactly on 59.97 as a double. That is the trap:
      // the bug shows up for some prices and not others, so spot-checking a
      // handful proves nothing. Integer arithmetic is right for all of them.
      expect(lineTotal('19.99', 3)).toBe('59.97');
    });

    it('handles the classic 0.1 + 0.2 shape', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
      expect(sumDecimals(['0.10', '0.20'])).toBe('0.30');
    });

    it('stays exact across a large quantity', () => {
      expect(lineTotal('0.07', 99)).toBe('6.93');
    });

    it('handles a zero-priced line (a free gift)', () => {
      expect(lineTotal('0.00', 5)).toBe('0.00');
    });
  });

  describe('sumDecimals', () => {
    it('sums a realistic basket exactly', () => {
      expect(sumDecimals(['19.99', '5.01', '1899.00', '0.07'])).toBe('1924.07');
    });

    it('sums a basket where the float version drifts', () => {
      const lines = ['0.29', '0.29', '0.29'];
      expect(sumDecimals(lines)).toBe('0.87');

      // The same sum as doubles is 0.8699999999999999 — under, not over, so
      // a naive toFixed(2) would round it back and hide the problem until
      // the error accumulated across enough lines to cross a boundary.
      const asFloat = lines.reduce((total, v) => total + Number(v), 0);
      expect(asFloat).not.toBe(0.87);
    });

    it('returns 0.00 for an empty cart, not an empty string', () => {
      expect(sumDecimals([])).toBe('0.00');
    });

    it('accumulates a hundred small amounts without drift', () => {
      const cents = Array.from({ length: 100 }, () => '0.01');
      expect(sumDecimals(cents)).toBe('1.00');
    });
  });
});

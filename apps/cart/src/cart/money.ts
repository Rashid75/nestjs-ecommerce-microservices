/**
 * Exact decimal arithmetic for money, done in INTEGER MINOR UNITS.
 *
 * WHY NOT JUST MULTIPLY THE NUMBERS.
 *
 *   Number('16.08') * 3          → 48.239999999999995
 *   Number('0.07') * 99          → 6.930000000000001
 *   0.1 + 0.2                    → 0.30000000000000004
 *
 * Not EVERY such product drifts — 19.99 * 3 happens to land exactly on
 * 59.97 — and that is precisely what makes the bug dangerous. It appears for
 * some values and not others, so spot-checking a few prices proves nothing.
 *
 * JavaScript numbers are IEEE-754 binary doubles and cannot represent most
 * two-decimal values exactly. Multiply and sum enough of them and a cart
 * subtotal disagrees with the sum of its own lines — a bug that reaches an
 * accountant before it reaches an engineer, and one that cannot be fixed
 * after the fact because you no longer know which figure was charged.
 *
 * The fix is to never leave the integers. '16.08' becomes 1608, all
 * arithmetic happens on whole numbers, and the result is formatted back at
 * the very end. 1608 * 3 = 4824 → '48.24', exactly, for every input.
 *
 * This is the same discipline as storing DECIMAL rather than FLOAT, applied
 * to the arithmetic instead of the storage. A production system would reach
 * for decimal.js or dinero.js; two functions are enough here, and being able
 * to read them is worth more than a dependency.
 *
 * Note the scale is hardcoded to 2. That is correct for USD, EUR and GBP and
 * WRONG for JPY (0 decimals) and KWD (3). Multi-currency pricing is a real
 * project of its own; the cart forbids mixing currencies, which keeps this
 * honest for now.
 */
const MINOR_UNITS_PER_MAJOR = 100;

/** '19.99' → 1999 */
export function toMinorUnits(decimalString: string): number {
  const [major = '0', minor = ''] = decimalString.split('.');
  const paddedMinor = minor.padEnd(2, '0').slice(0, 2);
  const sign = major.startsWith('-') ? -1 : 1;
  const absoluteMajor = Math.abs(Number(major));
  return sign * (absoluteMajor * MINOR_UNITS_PER_MAJOR + Number(paddedMinor));
}

/** 5997 → '59.97' */
export function toDecimalString(minorUnits: number): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(Math.round(minorUnits));
  const major = Math.floor(absolute / MINOR_UNITS_PER_MAJOR);
  const minor = absolute % MINOR_UNITS_PER_MAJOR;
  return `${sign}${major}.${String(minor).padStart(2, '0')}`;
}

/** unitPrice × quantity, exactly. */
export function lineTotal(unitPrice: string, quantity: number): string {
  return toDecimalString(toMinorUnits(unitPrice) * quantity);
}

/** Sum of line totals, exactly. */
export function sumDecimals(values: string[]): string {
  return toDecimalString(
    values.reduce((total, value) => total + toMinorUnits(value), 0),
  );
}

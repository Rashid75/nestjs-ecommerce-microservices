# @ecommerce/money

Exact decimal arithmetic for money, done in **integer minor units**.

```ts
import { lineTotal, sumDecimals } from '@ecommerce/money';

lineTotal('16.08', 3); // '48.24'  — not 48.239999999999995
sumDecimals(['19.99', '0.07']); // '20.06'
```

Money never becomes a JavaScript number. `Number('16.08') * 3` is
`48.239999999999995`, and the drift appears for some values and not others,
so spot-checking a few prices proves nothing. Every function here converts to
whole minor units first and formats back at the very end.

Read `src/lib/money.ts` — the reasoning is in the file, and it matters more
than the sixty lines of code.

**Scale is hardcoded to 2.** Correct for USD, EUR and GBP; wrong for JPY (0)
and KWD (3). The cart and the order both forbid mixing currencies, which
keeps that honest until multi-currency pricing is a project of its own.

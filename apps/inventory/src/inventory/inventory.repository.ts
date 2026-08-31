import { StockMovementType } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Transaction, UniqueConstraintError } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { InventoryItem } from './inventory-item.model';
import { StockMovement } from './stock-movement.model';

export interface InventoryRecord {
  id: string;
  productId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  updatedAt: Date;
}

export interface MovementRecord {
  id: string;
  type: StockMovementType;
  quantity: number;
  reference: string | null;
  onHandAfter: number;
  reservedAfter: number;
  createdAt: Date;
}

/** Raised when a product has no inventory row at all. */
export class InventoryNotFoundError extends Error {
  constructor(productId: string) {
    super(`no inventory for product ${productId}`);
    this.name = 'InventoryNotFoundError';
  }
}

/**
 * Raised when the operation was valid but the stock was not there.
 *
 * Distinct from InventoryNotFoundError: "we hold 2 and you asked for 5" is a
 * different answer to the client than "we have never heard of this product",
 * and they map to different status codes.
 */
export class InsufficientStockError extends Error {
  constructor(
    readonly productId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      `insufficient stock for ${productId}: requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientStockError';
  }
}

/** Shape returned by the atomic UPDATE ... RETURNING statements below. */
interface UpdatedRow {
  id: string;
  product_id: string;
  sku: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  updated_at: Date;
}

@Injectable()
export class InventoryRepository {
  constructor(
    @InjectModel(InventoryItem)
    private readonly items: typeof InventoryItem,
    @InjectModel(StockMovement)
    private readonly movements: typeof StockMovement,
    private readonly sequelize: Sequelize,
  ) {}

  // ===================================================================
  //  THE CORE OF THIS MILESTONE
  //
  //  THE OVERSELLING RACE, precisely.
  //
  //  Stock is 1. Two customers press Buy at the same instant. The obvious
  //  implementation is:
  //
  //      1. SELECT quantity_on_hand - quantity_reserved  -- read
  //      2. if (available >= 1)                          -- decide
  //      3. UPDATE ... SET quantity_reserved = 1         -- write
  //
  //  Interleave two of those and the sequence is:
  //
  //      A: SELECT → available = 1
  //      B: SELECT → available = 1     ← B read BEFORE A wrote
  //      A: check 1 >= 1 → ok
  //      B: check 1 >= 1 → ok          ← decided on a value now stale
  //      A: UPDATE reserved = 1
  //      B: UPDATE reserved = 1        ← last write wins; still 1
  //
  //  Both customers were told yes. One item was sold twice.
  //
  //  Note WHY this happens: the gap between the read and the write. The
  //  decision is made on a value that another transaction is free to change
  //  before the write lands. This is a CHECK-THEN-ACT race, exactly the same
  //  shape as the duplicate-email problem in the Auth Service — and it has
  //  the same family of fixes.
  //
  //  Wrapping all three steps in a transaction does NOT fix it. Under
  //  PostgreSQL's default READ COMMITTED isolation, a plain SELECT takes no
  //  lock, so both transactions read 1 and both proceed. A transaction gives
  //  you atomicity — all three statements commit or none do — which is not
  //  the same as mutual exclusion. Believing otherwise is the single most
  //  common misunderstanding in this area.
  //
  //  THREE REAL FIXES:
  //
  //  1. PESSIMISTIC LOCK — SELECT ... FOR UPDATE
  //     Takes a row lock on the read. B blocks until A commits, then re-reads
  //     and sees 0. Correct, and easy to reason about. The cost is that the
  //     lock is held for as long as the application takes to decide, so any
  //     slow work between the read and the write becomes lock contention.
  //     Needed when the decision spans several rows.
  //
  //  2. OPTIMISTIC LOCK — WHERE version = :seen
  //     No lock. Both proceed; the loser's UPDATE matches zero rows and it
  //     retries. Right when collisions are RARE and think-time is long — a
  //     human with a form open for thirty seconds. Wrong for a flash sale,
  //     where it degenerates into a retry storm.
  //
  //  3. ATOMIC CONDITIONAL UPDATE — the check IS the write
  //     UPDATE ... SET reserved = reserved + :n
  //      WHERE product_id = :id AND (on_hand - reserved) >= :n
  //     One statement. No gap, because there is nothing between the read and
  //     the write to interleave with. The database takes a row lock for the
  //     duration of the UPDATE, evaluates the condition against the CURRENT
  //     committed row, and either matches one row or zero. Zero rows means
  //     "someone beat you to it" — a definitive answer, not a guess.
  //
  //  We use (3). One round trip, no lock held across application logic, and
  //  the invariant is enforced by the same statement that changes the data.
  //  (1) is demonstrated in reserveWithPessimisticLock() below for contrast.
  //
  //  SUBTLETY WORTH KNOWING. Under READ COMMITTED, when an UPDATE finds a row
  //  another transaction has concurrently modified, PostgreSQL waits for that
  //  transaction, then RE-EVALUATES the WHERE clause against the new row
  //  version (this is EvalPlanQual). That re-evaluation is exactly what makes
  //  (3) safe at the default isolation level. Under REPEATABLE READ the same
  //  situation raises `could not serialize access` instead, and the
  //  application must retry. Same statement, different isolation, different
  //  correct handling — which is why "just use SERIALIZABLE" is not free
  //  advice.
  // ===================================================================

  /**
   * Reserve stock. THE critical operation.
   *
   * Returns null when the row is missing; throws InsufficientStockError when
   * the row exists but has too little available.
   *
   * Everything happens inside one transaction: the conditional UPDATE and
   * the ledger entry either both land or neither does. A reservation with no
   * ledger row would be stock that moved with no explanation.
   */
  async reserve(
    productId: string,
    quantity: number,
    reference: string | null,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      // The atomic conditional UPDATE. The availability check lives in the
      // WHERE clause, so there is no window between deciding and acting.
      //
      // `RETURNING` hands back the post-update row in the same round trip,
      // which is what lets the ledger entry record accurate `*_after`
      // figures without a second SELECT.
      const rows = await this.sequelize.query<UpdatedRow>(
        `UPDATE inventory_items
            SET quantity_reserved = quantity_reserved + :quantity,
                version           = version + 1,
                updated_at        = now()
          WHERE product_id = :productId
            AND (quantity_on_hand - quantity_reserved) >= :quantity
        RETURNING id, product_id, sku, quantity_on_hand, quantity_reserved, updated_at`,
        {
          replacements: { productId, quantity },
          type: QueryTypes.SELECT,
          transaction,
        },
      );

      const updated = rows[0];

      if (updated === undefined) {
        // Zero rows matched. TWO possible causes, and the client deserves to
        // know which — so we pay for one extra SELECT on the failure path
        // only. The happy path stays a single statement.
        const current = await this.findByProductId(productId, transaction);
        if (current === null) {
          throw new InventoryNotFoundError(productId);
        }
        throw new InsufficientStockError(
          productId,
          quantity,
          current.available,
        );
      }

      await this.recordMovement(
        updated,
        StockMovementType.Reserve,
        quantity,
        reference,
        transaction,
      );

      return toRecord(updated);
    });
  }

  /**
   * Release a previous reservation — an abandoned cart, a cancelled order.
   *
   * The guard is `quantity_reserved >= :quantity`. Without it a buggy caller
   * could release more than was ever reserved and drive the counter
   * negative, silently inventing available stock. The CHECK constraint would
   * catch that too, but as a 500 rather than a clear 409 — controls are more
   * useful when they fire at the layer that can explain them.
   */
  async release(
    productId: string,
    quantity: number,
    reference: string | null,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<UpdatedRow>(
        `UPDATE inventory_items
            SET quantity_reserved = quantity_reserved - :quantity,
                version           = version + 1,
                updated_at        = now()
          WHERE product_id = :productId
            AND quantity_reserved >= :quantity
        RETURNING id, product_id, sku, quantity_on_hand, quantity_reserved, updated_at`,
        {
          replacements: { productId, quantity },
          type: QueryTypes.SELECT,
          transaction,
        },
      );

      const updated = rows[0];
      if (updated === undefined) {
        const current = await this.findByProductId(productId, transaction);
        if (current === null) {
          throw new InventoryNotFoundError(productId);
        }
        throw new InsufficientStockError(productId, quantity, current.reserved);
      }

      await this.recordMovement(
        updated,
        StockMovementType.Release,
        -quantity,
        reference,
        transaction,
      );

      return toRecord(updated);
    });
  }

  /**
   * Fulfil — the goods actually left the building.
   *
   * BOTH counters drop. This is the only operation that reduces `on_hand`
   * through the normal flow, and it is why reserving does not touch
   * `on_hand`: until an item ships it is still physically present, and
   * decrementing early would make the system disagree with the shelf.
   */
  async fulfil(
    productId: string,
    quantity: number,
    reference: string | null,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<UpdatedRow>(
        `UPDATE inventory_items
            SET quantity_on_hand   = quantity_on_hand - :quantity,
                quantity_reserved  = quantity_reserved - :quantity,
                version            = version + 1,
                updated_at         = now()
          WHERE product_id = :productId
            AND quantity_reserved >= :quantity
            AND quantity_on_hand  >= :quantity
        RETURNING id, product_id, sku, quantity_on_hand, quantity_reserved, updated_at`,
        {
          replacements: { productId, quantity },
          type: QueryTypes.SELECT,
          transaction,
        },
      );

      const updated = rows[0];
      if (updated === undefined) {
        const current = await this.findByProductId(productId, transaction);
        if (current === null) {
          throw new InventoryNotFoundError(productId);
        }
        throw new InsufficientStockError(productId, quantity, current.reserved);
      }

      await this.recordMovement(
        updated,
        StockMovementType.Fulfil,
        -quantity,
        reference,
        transaction,
      );

      return toRecord(updated);
    });
  }

  /** Goods arrived. Unconditional — receiving can never fail on availability. */
  async receive(
    productId: string,
    quantity: number,
    reference: string | null,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<UpdatedRow>(
        `UPDATE inventory_items
            SET quantity_on_hand = quantity_on_hand + :quantity,
                version          = version + 1,
                updated_at       = now()
          WHERE product_id = :productId
        RETURNING id, product_id, sku, quantity_on_hand, quantity_reserved, updated_at`,
        {
          replacements: { productId, quantity },
          type: QueryTypes.SELECT,
          transaction,
        },
      );

      const updated = rows[0];
      if (updated === undefined) {
        throw new InventoryNotFoundError(productId);
      }

      await this.recordMovement(
        updated,
        StockMovementType.Receive,
        quantity,
        reference,
        transaction,
      );

      return toRecord(updated);
    });
  }

  /**
   * A signed manual correction — a stock count, breakage, a return.
   *
   * The guard `quantity_on_hand + :delta >= quantity_reserved` refuses an
   * adjustment that would leave more reserved than held. Without it, writing
   * off damaged goods could invalidate promises already made to customers,
   * and the failure would surface later as an order that cannot ship.
   */
  async adjust(
    productId: string,
    delta: number,
    reason: string,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<UpdatedRow>(
        `UPDATE inventory_items
            SET quantity_on_hand = quantity_on_hand + :delta,
                version          = version + 1,
                updated_at       = now()
          WHERE product_id = :productId
            AND (quantity_on_hand + :delta) >= 0
            AND (quantity_on_hand + :delta) >= quantity_reserved
        RETURNING id, product_id, sku, quantity_on_hand, quantity_reserved, updated_at`,
        {
          replacements: { productId, delta },
          type: QueryTypes.SELECT,
          transaction,
        },
      );

      const updated = rows[0];
      if (updated === undefined) {
        const current = await this.findByProductId(productId, transaction);
        if (current === null) {
          throw new InventoryNotFoundError(productId);
        }
        throw new InsufficientStockError(
          productId,
          Math.abs(delta),
          current.onHand - current.reserved,
        );
      }

      await this.recordMovement(
        updated,
        StockMovementType.Adjust,
        delta,
        reason,
        transaction,
      );

      return toRecord(updated);
    });
  }

  /**
   * The same reservation, written with a PESSIMISTIC LOCK, for contrast.
   *
   * Not wired to any route — it exists to be read next to `reserve()` above.
   *
   * `SELECT ... FOR UPDATE` takes a row-level exclusive lock. A second
   * transaction reaching this line blocks until the first commits or rolls
   * back, then reads the updated row. The race is closed by SERIALISING the
   * two transactions rather than by making the check atomic.
   *
   * When you actually need this rather than the conditional UPDATE:
   *
   *   - the decision depends on SEVERAL rows ("reserve all five items in
   *     this order, or none");
   *   - work must happen between reading and writing that cannot be
   *     expressed in one statement;
   *   - you need to read the current value and return it as part of a larger
   *     computation.
   *
   * What it costs: the lock is held for the whole transaction, so anything
   * slow in between — an HTTP call, say — becomes lock contention, and
   * locking several rows in inconsistent order across transactions is how
   * you get DEADLOCKS. PostgreSQL detects and kills one of them, but that is
   * a 500 for somebody. Lock rows in a consistent order (by id) when you
   * take more than one.
   */
  async reserveWithPessimisticLock(
    productId: string,
    quantity: number,
    reference: string | null,
  ): Promise<InventoryRecord> {
    return this.sequelize.transaction(async (transaction) => {
      const locked = await this.items.findOne({
        where: { productId },
        // Sequelize's `lock` maps to FOR UPDATE. Everything from here until
        // COMMIT holds an exclusive lock on this row.
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (locked === null) {
        throw new InventoryNotFoundError(productId);
      }

      // Safe to read-modify-write now: nobody else can touch this row.
      const available = locked.onHand - locked.reserved;
      if (available < quantity) {
        throw new InsufficientStockError(productId, quantity, available);
      }

      locked.reserved += quantity;
      await locked.save({ transaction });

      await this.recordMovement(
        {
          id: locked.id,
          product_id: locked.productId,
          sku: locked.sku,
          quantity_on_hand: locked.onHand,
          quantity_reserved: locked.reserved,
          updated_at: locked.updatedAt,
        },
        StockMovementType.Reserve,
        quantity,
        reference,
        transaction,
      );

      return {
        id: locked.id,
        productId: locked.productId,
        sku: locked.sku,
        onHand: locked.onHand,
        reserved: locked.reserved,
        available: locked.onHand - locked.reserved,
        updatedAt: locked.updatedAt,
      };
    });
  }

  // ---------------- plain reads and setup ----------------

  async create(
    productId: string,
    sku: string,
    onHand: number,
  ): Promise<InventoryRecord> {
    try {
      const created = await this.items.create({
        productId,
        sku,
        onHand,
        reserved: 0,
      } as InventoryItem);

      if (onHand > 0) {
        await this.recordMovement(
          {
            id: created.id,
            product_id: created.productId,
            sku: created.sku,
            quantity_on_hand: created.onHand,
            quantity_reserved: created.reserved,
            updated_at: created.updatedAt,
          },
          StockMovementType.Receive,
          onHand,
          'opening balance',
          undefined,
        );
      }

      return {
        id: created.id,
        productId: created.productId,
        sku: created.sku,
        onHand: created.onHand,
        reserved: created.reserved,
        available: created.onHand - created.reserved,
        updatedAt: created.updatedAt,
      };
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        // One inventory row per product, enforced by the unique index.
        throw new Error(`inventory already exists for product ${productId}`);
      }
      throw error;
    }
  }

  async findByProductId(
    productId: string,
    transaction?: Transaction,
  ): Promise<InventoryRecord | null> {
    const found = await this.items.findOne({
      where: { productId },
      transaction,
    });
    if (found === null) {
      return null;
    }
    return {
      id: found.id,
      productId: found.productId,
      sku: found.sku,
      onHand: found.onHand,
      reserved: found.reserved,
      available: found.onHand - found.reserved,
      updatedAt: found.updatedAt,
    };
  }

  async findMovements(
    inventoryItemId: string,
    limit: number,
  ): Promise<MovementRecord[]> {
    const rows = await this.movements.findAll({
      where: { inventoryItemId },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      quantity: row.quantity,
      reference: row.reference,
      onHandAfter: row.onHandAfter,
      reservedAfter: row.reservedAfter,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Writes the ledger entry.
   *
   * Always called with the SAME transaction as the balance change, so the
   * two are atomic. A balance that moved without a ledger row is stock with
   * no explanation, and reconciliation would report a discrepancy that never
   * actually happened.
   */
  private async recordMovement(
    row: UpdatedRow,
    type: StockMovementType,
    signedQuantity: number,
    reference: string | null,
    transaction: Transaction | undefined,
  ): Promise<void> {
    await this.movements.create(
      {
        inventoryItemId: row.id,
        type,
        quantity: signedQuantity,
        reference,
        onHandAfter: Number(row.quantity_on_hand),
        reservedAfter: Number(row.quantity_reserved),
      } as StockMovement,
      { transaction },
    );
  }
}

function toRecord(row: UpdatedRow): InventoryRecord {
  const onHand = Number(row.quantity_on_hand);
  const reserved = Number(row.quantity_reserved);
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    onHand,
    reserved,
    available: onHand - reserved,
    updatedAt: row.updated_at,
  };
}

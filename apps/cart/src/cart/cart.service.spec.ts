import { NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { ProductLookupService } from '../catalog/product-lookup.service';
import { CartRecord, CartRepository } from './cart.repository';
import { CartService } from './cart.service';

const USER_ID = '77777777-7777-4777-8777-777777777777';
const PRODUCT_ID = '88888888-8888-4888-8888-888888888888';

type RepoFake = {
  findOrCreateActive: jest.Mock;
  findActive: jest.Mock;
  addItem: jest.Mock;
  setQuantity: jest.Mock;
  removeItem: jest.Mock;
  clear: jest.Mock;
};

function makeRepo(cart: CartRecord): RepoFake {
  return {
    findOrCreateActive: jest.fn().mockResolvedValue(cart),
    findActive: jest.fn().mockResolvedValue(cart),
    addItem: jest.fn(),
    setQuantity: jest.fn().mockResolvedValue(true),
    removeItem: jest.fn().mockResolvedValue(true),
    clear: jest.fn(),
  };
}

function makeProducts(
  snapshot: Record<string, unknown> = {},
): ProductLookupService {
  return {
    fetchSnapshot: jest.fn().mockResolvedValue({
      productId: PRODUCT_ID,
      sku: 'LAP-1',
      name: 'ThinkPad',
      unitPrice: '1899.00',
      currency: 'USD',
      ...snapshot,
    }),
  } as unknown as ProductLookupService;
}

function makeCart(items: CartRecord['items'] = []): CartRecord {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    userId: USER_ID,
    currency: 'USD',
    items,
    updatedAt: new Date('2026-08-31T00:00:00Z'),
  };
}

function makeItem(
  unitPrice: string,
  quantity: number,
  productId = PRODUCT_ID,
): CartRecord['items'][number] {
  return {
    id: `item-${productId}`,
    productId,
    sku: 'LAP-1',
    name: 'ThinkPad',
    unitPrice,
    quantity,
    addedAt: new Date('2026-08-31T00:00:00Z'),
  };
}

describe('CartService', () => {
  describe('totals', () => {
    it('computes line totals and subtotal with exact decimal arithmetic', async () => {
      const repo = makeRepo(
        makeCart([
          makeItem('19.99', 3),
          makeItem('5.01', 1, '11111111-1111-4111-8111-111111111111'),
        ]),
      );

      const cart = await new CartService(
        repo as unknown as CartRepository,
        makeProducts(),
      ).getCart(USER_ID);

      // 19.99 × 3 in floating point is 59.96999999999999.
      expect(cart.items[0].lineTotal).toBe('59.97');
      expect(cart.subtotal).toBe('64.98');
    });

    it('reports an empty cart as 0.00, not an empty string or NaN', async () => {
      const repo = makeRepo(makeCart());

      const cart = await new CartService(
        repo as unknown as CartRepository,
        makeProducts(),
      ).getCart(USER_ID);

      expect(cart.subtotal).toBe('0.00');
      expect(cart.itemCount).toBe(0);
      expect(cart.totalQuantity).toBe(0);
    });

    it('distinguishes line count from total quantity', async () => {
      const repo = makeRepo(
        makeCart([
          makeItem('10.00', 2),
          makeItem('10.00', 3, '11111111-1111-4111-8111-111111111111'),
        ]),
      );

      const cart = await new CartService(
        repo as unknown as CartRepository,
        makeProducts(),
      ).getCart(USER_ID);

      // Two lines, five units. Conflating these is how a cart badge shows
      // "2" when the customer has five items.
      expect(cart.itemCount).toBe(2);
      expect(cart.totalQuantity).toBe(5);
    });
  });

  describe('addItem', () => {
    it('takes the price from the Product Service, never from the request', async () => {
      const repo = makeRepo(makeCart());
      const products = makeProducts();

      await new CartService(
        repo as unknown as CartRepository,
        products,
      ).addItem(USER_ID, { productId: PRODUCT_ID, quantity: 2 });

      expect(products.fetchSnapshot).toHaveBeenCalledWith(PRODUCT_ID);
      const [, snapshot, quantity] = repo.addItem.mock.calls[0];
      expect(snapshot.unitPrice).toBe('1899.00');
      expect(quantity).toBe(2);
    });

    it('defaults quantity to 1', async () => {
      const repo = makeRepo(makeCart());

      await new CartService(
        repo as unknown as CartRepository,
        makeProducts(),
      ).addItem(USER_ID, { productId: PRODUCT_ID });

      expect(repo.addItem.mock.calls[0][2]).toBe(1);
    });

    it('does not write when the product lookup fails', async () => {
      const repo = makeRepo(makeCart());
      const products = {
        fetchSnapshot: jest
          .fn()
          .mockRejectedValue(new BadRequestException('no such product')),
      } as unknown as ProductLookupService;

      await expect(
        new CartService(repo as unknown as CartRepository, products).addItem(
          USER_ID,
          { productId: PRODUCT_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Fetch first, write second — so a failed lookup leaves nothing to
      // undo. Writing first would need a compensating delete: a miniature
      // Saga, for no benefit.
      expect(repo.addItem).not.toHaveBeenCalled();
    });
  });

  describe('updateItem', () => {
    it('404s when the line is not in the cart', async () => {
      const repo = makeRepo(makeCart());
      repo.setQuantity.mockResolvedValue(false);

      await expect(
        new CartService(
          repo as unknown as CartRepository,
          makeProducts(),
        ).updateItem(USER_ID, PRODUCT_ID, { quantity: 3 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does NOT re-price the line', async () => {
      const repo = makeRepo(makeCart([makeItem('19.99', 1)]));
      const products = makeProducts({ unitPrice: '29.99' });

      await new CartService(
        repo as unknown as CartRepository,
        products,
      ).updateItem(USER_ID, PRODUCT_ID, { quantity: 5 });

      // Changing a quantity must not quietly reprice. The snapshot is what
      // the customer was shown; repricing on an unrelated action is exactly
      // the surprise snapshotting exists to prevent.
      expect(products.fetchSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('404s when the line is not in the cart', async () => {
      const repo = makeRepo(makeCart());
      repo.removeItem.mockResolvedValue(false);

      await expect(
        new CartService(
          repo as unknown as CartRepository,
          makeProducts(),
        ).removeItem(USER_ID, PRODUCT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('clear', () => {
    it('empties the lines but keeps the cart', async () => {
      const repo = makeRepo(makeCart([makeItem('10.00', 1)]));

      await new CartService(
        repo as unknown as CartRepository,
        makeProducts(),
      ).clear(USER_ID);

      // The cart row carries the identity and creation time that
      // abandonment analytics rely on. Deleting it to save one row destroys
      // history.
      expect(repo.clear).toHaveBeenCalledTimes(1);
    });
  });
});

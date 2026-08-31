import {
  AddCartItemDto,
  CartDto,
  UpdateCartItemDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CartService } from './cart.service';
import { CurrentUserId } from './current-user.decorator';

/**
 * REST for the cart.
 *
 * Note there is NO `:cartId` anywhere in these routes. The cart is always
 * "mine" — identified by the authenticated user, never by a path parameter.
 *
 * That is a deliberate security property, not a convenience. An endpoint
 * shaped `GET /carts/:cartId` invites INSECURE DIRECT OBJECT REFERENCE: the
 * handler must remember to check that the cart belongs to the caller, and
 * the day someone forgets, incrementing an id reads a stranger's basket.
 * With no id in the URL there is nothing to forget — ownership is
 * structural.
 *
 * Every mutation returns the whole cart, so a client never needs a follow-up
 * GET to re-render.
 */
@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current cart, creating an empty one if needed',
    description:
      'Idempotent: repeated calls return the same cart, guaranteed by a partial unique index rather than by convention.',
  })
  @ApiResponse({ status: 200, type: CartDto })
  getCart(@CurrentUserId() userId: string): Promise<CartDto> {
    return this.cart.getCart(userId);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Add a product to the cart',
    description:
      'An upsert: adding a product already present increases its quantity rather than creating a second line. Price and name are snapshotted from the Product Service — never taken from the request.',
  })
  @ApiResponse({ status: 201, type: CartDto })
  @ApiResponse({ status: 400, description: 'Unknown or unavailable product' })
  @ApiResponse({ status: 503, description: 'Catalogue unavailable' })
  addItem(
    @CurrentUserId() userId: string,
    @Body() dto: AddCartItemDto,
  ): Promise<CartDto> {
    return this.cart.addItem(userId, dto);
  }

  @Patch('items/:productId')
  @ApiOperation({
    summary: 'Set the quantity of a line',
    description:
      'An ABSOLUTE quantity, not a delta — so a retried request cannot double the line. Minimum 1; use DELETE to remove.',
  })
  @ApiResponse({ status: 200, type: CartDto })
  @ApiResponse({ status: 404, description: 'That product is not in the cart' })
  updateItem(
    @CurrentUserId() userId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartDto> {
    return this.cart.updateItem(userId, productId, dto);
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a line from the cart' })
  @ApiResponse({ status: 200, type: CartDto })
  @ApiResponse({ status: 404, description: 'That product is not in the cart' })
  removeItem(
    @CurrentUserId() userId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<CartDto> {
    return this.cart.removeItem(userId, productId);
  }

  @Delete()
  @ApiOperation({
    summary: 'Empty the cart',
    description:
      'Removes the lines and KEEPS the cart row — its identity and creation time are what abandonment analytics rely on.',
  })
  @ApiResponse({ status: 200, type: CartDto })
  clear(@CurrentUserId() userId: string): Promise<CartDto> {
    return this.cart.clear(userId);
  }
}

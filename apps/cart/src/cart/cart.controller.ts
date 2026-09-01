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
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  getCart(@CurrentUserId() userId: string): Promise<CartDto> {
    return this.cart.getCart(userId);
  }

  @Post('items')
  addItem(
    @CurrentUserId() userId: string,
    @Body() dto: AddCartItemDto,
  ): Promise<CartDto> {
    return this.cart.addItem(userId, dto);
  }

  @Patch('items/:productId')
  updateItem(
    @CurrentUserId() userId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartDto> {
    return this.cart.updateItem(userId, productId, dto);
  }

  @Delete('items/:productId')
  removeItem(
    @CurrentUserId() userId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<CartDto> {
    return this.cart.removeItem(userId, productId);
  }

  @Delete()
  clear(@CurrentUserId() userId: string): Promise<CartDto> {
    return this.cart.clear(userId);
  }
}

import {
  AddCartItemDto,
  CartDto,
  UpdateCartItemDto,
  UserProfileDto,
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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../common/authenticated-user.decorator';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import { CartProxyService } from './cart-proxy.service';

/**
 * The PUBLIC cart API — and the first authenticated resource in this system.
 *
 * `@UseGuards(AuthenticatedUserGuard)` sits on the CLASS, so it applies to
 * every route here including any added later. On a resource where every
 * single route needs the same protection, class-level is strictly safer than
 * repeating the decorator: a new method inherits it rather than silently
 * shipping unguarded.
 *
 * WHY THE CART IS AUTHENTICATED WHEN THE CATALOGUE IS NOT — worth being
 * precise, because it is not inconsistency for its own sake.
 *
 * A cart is inherently user-scoped: "your cart" is meaningless without a
 * "you". There is no version of this feature that works anonymously in the
 * way a product listing does. So identity is not an add-on here, it is the
 * data model.
 *
 * The catalogue and inventory write endpoints remain unauthenticated, which
 * is a real and acknowledged gap. This guard is now the tool that closes it —
 * applying it there, plus a `@Roles(ADMIN)` check, is a small change rather
 * than a project. That decision is still outstanding.
 *
 * Note also: no `:cartId` in any route. The cart is always the caller's own,
 * so there is no id to tamper with and no ownership check to forget. That is
 * how you make insecure direct object reference structurally impossible
 * rather than merely guarded against.
 */
@UseGuards(AuthenticatedUserGuard)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartProxyService) {}

  @Get()
  getCart(@AuthenticatedUser() user?: UserProfileDto): Promise<CartDto> {
    return this.cart.getCart(requireUser(user).id);
  }

  @Post('items')
  addItem(
    @Body() dto: AddCartItemDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<CartDto> {
    return this.cart.addItem(requireUser(user).id, dto);
  }

  @Patch('items/:productId')
  updateItem(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: UpdateCartItemDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<CartDto> {
    return this.cart.updateItem(requireUser(user).id, productId, dto);
  }

  @Delete('items/:productId')
  removeItem(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<CartDto> {
    return this.cart.removeItem(requireUser(user).id, productId);
  }

  @Delete()
  clear(@AuthenticatedUser() user?: UserProfileDto): Promise<CartDto> {
    return this.cart.clear(requireUser(user).id);
  }
}

/**
 * Unreachable while the guard is in place — which is exactly why it exists.
 *
 * The guard is the only thing making `user` defined, and guards get removed
 * during refactors. Failing loudly here beats forwarding `undefined` as a
 * user id and letting every anonymous request share one basket.
 */
function requireUser(user: UserProfileDto | undefined): UserProfileDto {
  if (user === undefined) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}

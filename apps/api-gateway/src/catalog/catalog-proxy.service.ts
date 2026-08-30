import {
  CategoryDto,
  PaginatedProductsDto,
  ProductDto,
  QueryProductsDto,
} from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

/**
 * Forwards catalogue calls to the Product Service.
 *
 * Note how little is here. The gateway does not know that products live in
 * PostgreSQL, that categories are soft-deleted, or that SKUs are unique. It
 * knows one base URL and a set of paths — which is exactly what "hides the
 * internal topology" means in practice. Split the Product Service into
 * Catalog and Pricing later and only this file changes.
 */
@Injectable()
export class CatalogProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Product service');
  }

  // --- products ---

  listProducts(
    query: QueryProductsDto,
  ): Promise<{ data: PaginatedProductsDto; headers: Record<string, string> }> {
    return this.forwardWithHeaders<PaginatedProductsDto>({
      method: 'GET',
      url: '/products',
      // `params`, not string concatenation. axios serialises and URL-encodes
      // each value, so a search term containing `&` or `#` cannot smuggle
      // extra parameters into the downstream request.
      params: query,
    });
  }

  getProduct(
    id: string,
  ): Promise<{ data: ProductDto; headers: Record<string, string> }> {
    return this.forwardWithHeaders<ProductDto>({
      method: 'GET',
      url: `/products/${id}`,
    });
  }

  createProduct(body: unknown): Promise<ProductDto> {
    return this.forward<ProductDto>({
      method: 'POST',
      url: '/products',
      data: body,
    });
  }

  updateProduct(id: string, body: unknown): Promise<ProductDto> {
    return this.forward<ProductDto>({
      method: 'PATCH',
      url: `/products/${id}`,
      data: body,
    });
  }

  deleteProduct(id: string): Promise<void> {
    return this.forward<void>({ method: 'DELETE', url: `/products/${id}` });
  }

  // --- categories ---

  listCategories(includeInactive: boolean): Promise<CategoryDto[]> {
    return this.forward<CategoryDto[]>({
      method: 'GET',
      url: '/categories',
      params: { includeInactive },
    });
  }

  getCategory(id: string): Promise<CategoryDto> {
    return this.forward<CategoryDto>({
      method: 'GET',
      url: `/categories/${id}`,
    });
  }

  createCategory(body: unknown): Promise<CategoryDto> {
    return this.forward<CategoryDto>({
      method: 'POST',
      url: '/categories',
      data: body,
    });
  }

  updateCategory(id: string, body: unknown): Promise<CategoryDto> {
    return this.forward<CategoryDto>({
      method: 'PATCH',
      url: `/categories/${id}`,
      data: body,
    });
  }

  deleteCategory(id: string): Promise<void> {
    return this.forward<void>({ method: 'DELETE', url: `/categories/${id}` });
  }
}

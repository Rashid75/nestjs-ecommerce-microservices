import type {
  OrderConfirmedPayload,
  PaymentSucceededPayload,
  UserRegisteredPayload,
} from '@ecommerce/contracts';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The email templates.
 *
 * PLAIN FUNCTIONS, not Handlebars or Pug. Three emails do not need a
 * template engine: the whole of it would be one dependency, one directory of
 * files loaded at runtime, and one more thing that can fail in production
 * because a file was not copied into the container. When there are thirty
 * emails in four languages, that trade reverses — and the seam is this file,
 * because nothing outside it knows how an email is built.
 *
 * EVERY EMAIL IS SENT AS BOTH text AND html. Not for tidiness: a plain-text
 * part is what screen readers, text-only clients and most spam filters
 * actually read, and an HTML-only email scores worse and is less accessible.
 *
 * WHAT IS NOT IN HERE: any styling worth the name. Real transactional email
 * is tables and inline styles, because Outlook does not support flexbox and
 * Gmail strips `<style>` blocks. That is a genuine craft and it is not what
 * this milestone is teaching, so these are deliberately plain.
 */

/** `19.99` → `$19.99`. Display only — never used for arithmetic. */
function money(amount: string, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '';
  return symbol === '' ? `${amount} ${currency}` : `${symbol}${amount}`;
}

/** Escapes text going into HTML. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(heading: string, body: string): string {
  // A single inline-styled container. No <style> block, because Gmail
  // removes them.
  return [
    '<div style="font-family: -apple-system, Segoe UI, Helvetica, sans-serif; max-width: 560px; color: #1a1a1a;">',
    `<h1 style="font-size: 20px; margin: 0 0 16px;">${escape(heading)}</h1>`,
    body,
    '<p style="font-size: 12px; color: #767676; margin-top: 28px;">You are receiving this because you have an account with us.</p>',
    '</div>',
  ].join('\n');
}

export function welcomeEmail(user: UserRegisteredPayload): RenderedEmail {
  const name = user.firstName.trim() === '' ? 'there' : user.firstName;

  return {
    subject: 'Welcome',
    text: [
      `Hello ${name},`,
      '',
      'Your account is ready. You can browse the catalogue and start an order whenever you like.',
      '',
      'Thanks for signing up.',
    ].join('\n'),
    html: wrap(
      `Hello ${name}`,
      '<p>Your account is ready. You can browse the catalogue and start an order whenever you like.</p>',
    ),
  };
}

export function orderConfirmedEmail(
  order: OrderConfirmedPayload,
  firstName: string | null,
): RenderedEmail {
  const name =
    firstName === null || firstName.trim() === '' ? 'there' : firstName;
  const total = money(order.total, order.currency);

  const lines = order.lines.map(
    (line) =>
      `  ${line.quantity} × ${line.sku} at ${money(line.unitPrice, order.currency)}`,
  );

  const rows = order.lines
    .map(
      (line) =>
        `<tr><td style="padding: 6px 12px 6px 0;">${escape(line.sku)}</td>` +
        `<td style="padding: 6px 12px 6px 0; text-align: right;">${line.quantity}</td>` +
        `<td style="padding: 6px 0; text-align: right;">${escape(money(line.unitPrice, order.currency))}</td></tr>`,
    )
    .join('\n');

  return {
    // The order number in the subject, because that is what a customer
    // searches their inbox for when they phone up about it.
    subject: `Order ${order.orderNumber} confirmed`,
    text: [
      `Hello ${name},`,
      '',
      `We have your order ${order.orderNumber}.`,
      '',
      ...lines,
      '',
      `Total: ${total}`,
      '',
      // Said plainly, because it is true and because a customer who thinks
      // they have paid will not answer the email that asks them to.
      'This is a confirmation that we have your order. It is not a payment receipt.',
    ].join('\n'),
    html: wrap(
      `Order ${order.orderNumber} confirmed`,
      [
        `<p>Hello ${escape(name)}, we have your order.</p>`,
        '<table style="border-collapse: collapse; font-size: 14px;">',
        rows,
        `<tr><td colspan="2" style="padding: 10px 12px 0 0; border-top: 1px solid #e0e0e0; font-weight: 600;">Total</td>` +
          `<td style="padding: 10px 0 0; border-top: 1px solid #e0e0e0; text-align: right; font-weight: 600;">${escape(total)}</td></tr>`,
        '</table>',
        '<p style="font-size: 13px; color: #767676;">This confirms we have your order. It is not a payment receipt.</p>',
      ].join('\n'),
    ),
  };
}

export function paymentReceiptEmail(
  payment: PaymentSucceededPayload,
  firstName: string | null,
): RenderedEmail {
  const name =
    firstName === null || firstName.trim() === '' ? 'there' : firstName;
  const amount = money(payment.amount, payment.currency);

  return {
    subject: `Receipt ${payment.reference} — ${amount}`,
    text: [
      `Hello ${name},`,
      '',
      `We received ${amount}.`,
      '',
      `Receipt: ${payment.reference}`,
      // The provider's own id, because it is the one thing that lets a bank
      // or a support agent match this to a line on a statement.
      `Reference: ${payment.providerReference}`,
      '',
      'Keep this for your records.',
    ].join('\n'),
    html: wrap(
      `We received ${amount}`,
      [
        `<p>Hello ${escape(name)}, thank you — your payment went through.</p>`,
        '<table style="border-collapse: collapse; font-size: 14px;">',
        `<tr><td style="padding: 6px 16px 6px 0; color: #767676;">Amount</td><td style="padding: 6px 0;">${escape(amount)}</td></tr>`,
        `<tr><td style="padding: 6px 16px 6px 0; color: #767676;">Receipt</td><td style="padding: 6px 0;">${escape(payment.reference)}</td></tr>`,
        `<tr><td style="padding: 6px 16px 6px 0; color: #767676;">Reference</td><td style="padding: 6px 0;">${escape(payment.providerReference)}</td></tr>`,
        '</table>',
      ].join('\n'),
    ),
  };
}

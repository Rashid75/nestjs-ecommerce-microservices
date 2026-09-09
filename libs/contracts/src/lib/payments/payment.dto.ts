import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * What became of one attempt to take money.
 *
 *   PENDING    sent to the provider, no answer yet. A payment that stays
 *              here needs a human or a reconciliation job — it is the state
 *              where you do not know whether the customer was charged.
 *   SUCCEEDED  the provider approved it. Money is captured.
 *   DECLINED   the provider said no, and it means it. The card has no
 *              funds, the bank refused, the details are wrong. RETRYING
 *              THE SAME REQUEST WILL FAIL AGAIN.
 *   FAILED     we could not get an answer — a timeout, the provider is
 *              down, the network broke. Retrying may well work, and the
 *              outcome is genuinely UNKNOWN until it does.
 *
 * DECLINED and FAILED are the distinction this milestone is really about.
 * They look the same to a user ("it didn't work") and are opposite to a
 * client: one must not be retried, the other should be.
 */
export enum PaymentStatus {
  Pending = 'PENDING',
  Succeeded = 'SUCCEEDED',
  Declined = 'DECLINED',
  Failed = 'FAILED',
}

/**
 * Why a payment did not succeed, in the provider's terms.
 *
 * Kept separate from the status because "declined" is one outcome with many
 * causes, and support needs the cause. A customer told "insufficient funds"
 * can act; a customer told "declined" phones you.
 */
export enum PaymentFailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  CardExpired = 'CARD_EXPIRED',
  DoNotHonour = 'DO_NOT_HONOUR',
  SuspectedFraud = 'SUSPECTED_FRAUD',
  ProviderTimeout = 'PROVIDER_TIMEOUT',
  ProviderUnavailable = 'PROVIDER_UNAVAILABLE',
}

/**
 * The test tokens this mock provider understands.
 *
 * MODELLED ON REAL TEST CARDS, deliberately. Every payment provider ships a
 * set of values that force a particular outcome, because "log in to the
 * dashboard and cancel someone's card" is not a test you can automate.
 *
 * The important part is what a token IS: a reference the PROVIDER issued
 * after its own SDK collected the card in the customer's browser. The card
 * number never reaches this system. That is not a shortcut for a learning
 * project — it is the whole architecture of card payments, and the reason
 * this service is outside PCI scope. A `cardNumber` field here would put
 * every server, log and backup in it.
 */
export const PaymentToken = {
  /** Approved. */
  Ok: 'tok_ok',
  /** Declined — insufficient funds. Non-retryable. */
  Declined: 'tok_declined',
  /** Declined — the bank suspects fraud. Non-retryable. */
  Fraud: 'tok_fraud',
  /** The provider never answers. Retryable, outcome unknown. */
  Timeout: 'tok_timeout',
  /** The provider is down. Retryable. */
  Unavailable: 'tok_unavailable',
  /** Fails roughly half the time — for watching a retry actually help. */
  Flaky: 'tok_flaky',
} as const;

export type PaymentTokenValue =
  (typeof PaymentToken)[keyof typeof PaymentToken];

export class PaymentDto {
  id!: string;

  /** Human-facing reference: `PAY-00000042`. */
  reference!: string;

  orderId!: string;

  orderNumber!: string;

  userId!: string;

  status!: PaymentStatus;

  amount!: string;

  currency!: string;

  /**
   * The provider's own id for this charge, when it got far enough to have
   * one. This is what you quote when you phone them.
   */
  providerReference?: string | null;

  failureCode?: PaymentFailureCode | null;

  failureMessage?: string | null;

  /** Last four digits and brand — safe to store, safe to show. */
  cardLast4?: string | null;

  cardBrand?: string | null;

  /**
   * Whether trying again could plausibly work. Computed from the failure,
   * and exposed so a client does not have to maintain its own table of
   * which codes are worth retrying.
   */
  retryable!: boolean;

  createdAt!: Date;

  updatedAt!: Date;
}

export class CreatePaymentDto {
  @IsUUID('4')
  orderId!: string;

  /**
   * The provider's token for the customer's card.
   *
   * NOTE WHAT IS ABSENT: no card number, no CVV, no expiry, and no AMOUNT.
   * The amount is read from the order server-side — a client that could name
   * its own would pay 0.01 for a laptop.
   */
  @IsString()
  @Matches(/^tok_[a-z0-9_]{2,40}$/, {
    message:
      'paymentMethodToken must be a provider token such as "tok_ok" — never a card number',
  })
  paymentMethodToken!: string;
}

export class QueryPaymentsDto {
  @IsOptional()
  @IsUUID('4')
  orderId?: string;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * The header that makes a charge safe to retry.
 *
 * Declared in the shared contract because THREE parties must agree on the
 * spelling: the client, the gateway that forwards it, and the Payment
 * Service that enforces it. A typo in any one of them silently disables the
 * protection — the request still works, it just charges the customer again.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Set when a response replayed an EXISTING payment instead of making one.
 *
 * Without it a client cannot tell a replay from a fresh charge, which is
 * exactly what a retry loop needs to know.
 */
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';

/** Longest idempotency key the column will hold. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 100;

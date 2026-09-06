import { PaymentFailureCode, PaymentToken } from '@ecommerce/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PaymentEnv } from '../config/env.validation';

/** What the provider says back. */
export type ChargeResult =
  /** Money captured. */
  | {
      outcome: 'APPROVED';
      providerReference: string;
      last4: string;
      brand: string;
    }
  /**
   * The provider answered, and the answer is no. The request was well
   * formed and the card is real; the bank refused it. Retrying the identical
   * request produces the identical refusal.
   */
  | {
      outcome: 'DECLINED';
      code: PaymentFailureCode;
      message: string;
      providerReference: string;
    }
  /**
   * We got no usable answer. THE OUTCOME IS UNKNOWN — the charge may have
   * gone through. This is the single most dangerous state in payments, and
   * the reason idempotency keys exist.
   */
  | { outcome: 'ERROR'; code: PaymentFailureCode; message: string };

/** How the fake cards behave. */
interface TokenBehaviour {
  outcome: 'APPROVED' | 'DECLINED' | 'ERROR';
  code?: PaymentFailureCode;
  message?: string;
  last4: string;
  brand: string;
  /** Roughly how long the provider takes, in milliseconds. */
  latencyMs: number;
  /** For the flaky token: probability of failing on any given attempt. */
  failureRate?: number;
}

/**
 * A pretend payment provider.
 *
 * WHY A MOCK AND NOT STRIPE. Not to avoid the work — the integration itself
 * is a day. It is because the interesting part of payments is not the happy
 * path, which any SDK sample shows you, but the four failures below. Against
 * a real sandbox you can produce a decline on demand and you cannot produce
 * a timeout, a partial outage, or a duplicate charge on demand. Those are
 * exactly the ones that hurt, so those are the ones worth being able to run
 * whenever you like.
 *
 * WHAT IT IS FAITHFUL ABOUT, because a mock that lies teaches the wrong
 * lesson:
 *
 *   IT TAKES TIME. Real charges take a few hundred milliseconds to a few
 *   seconds. A mock that answers instantly hides every timeout question.
 *
 *   IT DISTINGUISHES "no" FROM "no answer". A decline is a business
 *   outcome; a timeout is an absence of information. Code that treats them
 *   alike is code that retries a declined card forever, or gives up on a
 *   charge that actually succeeded.
 *
 *   IT NEVER SEES A CARD. The token is a reference the provider issued
 *   after its own SDK collected the card in the customer's browser. If this
 *   method took a PAN, every log line and stack trace in this process would
 *   become a compliance problem.
 *
 * WHAT IT IS NOT: authorisation versus capture, 3-D Secure, partial
 * captures, multi-currency settlement, chargebacks. Each is real and each
 * would obscure the lesson here.
 */
@Injectable()
export class MockProviderService {
  private readonly logger = new Logger(MockProviderService.name);

  private readonly behaviours: Record<string, TokenBehaviour> = {
    [PaymentToken.Ok]: {
      outcome: 'APPROVED',
      last4: '4242',
      brand: 'VISA',
      latencyMs: 250,
    },
    [PaymentToken.Declined]: {
      outcome: 'DECLINED',
      code: PaymentFailureCode.InsufficientFunds,
      message: 'The card has insufficient funds',
      last4: '0002',
      brand: 'VISA',
      latencyMs: 300,
    },
    [PaymentToken.Fraud]: {
      outcome: 'DECLINED',
      code: PaymentFailureCode.SuspectedFraud,
      message: 'The issuing bank refused this transaction',
      last4: '0019',
      brand: 'MASTERCARD',
      latencyMs: 400,
    },
    [PaymentToken.Timeout]: {
      outcome: 'ERROR',
      code: PaymentFailureCode.ProviderTimeout,
      message: 'The payment provider did not respond in time',
      last4: '0069',
      brand: 'VISA',
      // Deliberately longer than the configured deadline, so the timeout is
      // real rather than announced.
      latencyMs: 30_000,
    },
    [PaymentToken.Unavailable]: {
      outcome: 'ERROR',
      code: PaymentFailureCode.ProviderUnavailable,
      message: 'The payment provider is unavailable',
      last4: '0341',
      brand: 'AMEX',
      latencyMs: 150,
    },
    [PaymentToken.Flaky]: {
      outcome: 'APPROVED',
      last4: '1976',
      brand: 'VISA',
      latencyMs: 350,
      failureRate: 0.5,
    },
  };

  constructor(private readonly config: ConfigService<PaymentEnv, true>) {}

  /**
   * Attempts a charge.
   *
   * Note the deadline. Every outbound call in this project has one, and here
   * it carries a specific meaning: when it fires, we do not know whether the
   * customer was charged. The right response to that is never "assume it
   * failed" — it is to record what we know, mark it retryable, and make the
   * retry safe.
   */
  async charge(
    token: string,
    amount: string,
    currency: string,
  ): Promise<ChargeResult> {
    const behaviour = this.behaviours[token];

    if (behaviour === undefined) {
      // An unknown token is the caller's mistake, not a provider failure.
      // Reported as a decline so it cannot be retried forever.
      return {
        outcome: 'DECLINED',
        code: PaymentFailureCode.DoNotHonour,
        message: `Unknown payment method token "${token}"`,
        providerReference: fakeProviderReference(),
      };
    }

    const timeoutMs = this.config.get('PAYMENT_PROVIDER_TIMEOUT_MS', {
      infer: true,
    });

    // The token never goes into the log — see the note about what this
    // service is allowed to hold. The amount and the deadline do.
    this.logger.log(`charging ${amount} ${currency} (deadline ${timeoutMs}ms)`);

    const answered = await raceDeadline(sleep(behaviour.latencyMs), timeoutMs);

    if (!answered) {
      // THE UNKNOWN OUTCOME. We stopped waiting; the provider did not stop
      // working. Somewhere out there the charge may be settling.
      this.logger.warn(
        `provider did not answer within ${timeoutMs}ms — outcome is UNKNOWN`,
      );
      return {
        outcome: 'ERROR',
        code: PaymentFailureCode.ProviderTimeout,
        message: 'The payment provider did not respond in time',
      };
    }

    if (
      behaviour.failureRate !== undefined &&
      Math.random() < behaviour.failureRate
    ) {
      return {
        outcome: 'ERROR',
        code: PaymentFailureCode.ProviderUnavailable,
        message: 'The payment provider is temporarily unavailable',
      };
    }

    if (behaviour.outcome === 'APPROVED') {
      return {
        outcome: 'APPROVED',
        providerReference: fakeProviderReference(),
        last4: behaviour.last4,
        brand: behaviour.brand,
      };
    }

    if (behaviour.outcome === 'DECLINED') {
      return {
        outcome: 'DECLINED',
        code: behaviour.code ?? PaymentFailureCode.DoNotHonour,
        message: behaviour.message ?? 'The card was declined',
        // A decline still gets a reference. The provider processed the
        // request and reached a decision, and support will need to quote it.
        providerReference: fakeProviderReference(),
      };
    }

    return {
      outcome: 'ERROR',
      code: behaviour.code ?? PaymentFailureCode.ProviderUnavailable,
      message: behaviour.message ?? 'The payment provider failed',
    };
  }

  /** The card details this token stands for, for display only. */
  describe(token: string): { last4: string | null; brand: string | null } {
    const behaviour = this.behaviours[token];
    return behaviour === undefined
      ? { last4: null, brand: null }
      : { last4: behaviour.last4, brand: behaviour.brand };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Does not hold the process open on its own — otherwise the 30-second
    // timeout token would keep the service alive for half a minute after
    // Ctrl-C.
    timer.unref?.();
  });
}

/** Resolves true if the work finished first, false if the deadline won. */
async function raceDeadline(
  work: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([work.then(() => true), deadline]);
  } finally {
    // Always cleared. A pending timer per request is a slow leak that only
    // shows up under load, which is the worst time to find it.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Shaped like a real provider id, so the format never surprises anyone. */
function fakeProviderReference(): string {
  return `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

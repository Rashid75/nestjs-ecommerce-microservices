import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import {
  BrokerHealthIndicator,
  DatabaseHealthIndicator,
  RedisHealthIndicator,
} from './health.indicators';

/**
 * `/health/live` and `/health/ready`, for any service that imports it.
 *
 * The indicators take their dependencies as OPTIONAL: the same module is
 * imported by a service with a database and Redis, and by one with neither.
 * An indicator whose dependency is absent reports "not configured" rather
 * than failing — reporting "down" for something that does not exist would
 * make every probe red for the wrong reason.
 *
 * `TerminusModule` gives the aggregation and the 200/503 response shape. The
 * indicators are ours because Terminus ships none for Sequelize, ioredis or
 * amqplib — and because what to check, and how long to wait, is precisely
 * the part worth deciding rather than inheriting.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    BrokerHealthIndicator,
  ],
  exports: [
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    BrokerHealthIndicator,
  ],
})
export class HealthModule {}

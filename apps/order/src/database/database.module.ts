import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { OrderEnv } from '../config/env.validation';

interface ConnectionFacts {
  version: string;
  database: string;
  role: string;
}

@Module({
  imports: [
    SequelizeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<OrderEnv, true>) => {
        const sqlLogger = new Logger('SQL');
        const loggingEnabled = config.get('ORDER_DB_LOGGING', {
          infer: true,
        });

        return {
          dialect: 'postgres' as const,
          host: config.get('ORDER_DB_HOST', { infer: true }),
          port: config.get('ORDER_DB_PORT', { infer: true }),
          username: config.get('ORDER_DB_USERNAME', { infer: true }),
          password: config.get('ORDER_DB_PASSWORD', { infer: true }),
          database: config.get('ORDER_DB_DATABASE', { infer: true }),

          // Hardcoded false, with no environment toggle, on purpose.
          //
          // `synchronize: true` lets Sequelize issue DDL to make the database
          // match the model classes. It is seductive in development and
          // catastrophic everywhere else: it silently drops and recreates
          // columns, it cannot express a data backfill, and it makes the
          // migration history a lie — the schema in production would no longer
          // be the sum of the migrations in git.
          //
          // Every schema change in this project goes through sequelize-cli.
          synchronize: false,

          // Collects models registered via SequelizeModule.forFeature() so this
          // module does not have to import every feature's model class.
          //
          // This does NOT create tables. That is `synchronize`, which is false
          // above. autoLoadModels only decides HOW the connection discovers
          // model classes; synchronize decides whether the ORM may emit DDL.
          // Conflating the two is why people believe registering a model must
          // create a table.
          autoLoadModels: true,

          logging: loggingEnabled
            ? (sql: string, timing?: number) =>
                sqlLogger.log(
                  timing === undefined ? sql : `${sql} (+${timing}ms)`,
                )
            : false,
          // Supplies the `timing` argument above. Without it you see the SQL
          // but not what it cost.
          benchmark: true,
          // Deliberately OFF. Enabling it appends bind parameter VALUES to
          // every logged statement, which would write password hashes and
          // email addresses into the application log. `$1`/`$2` placeholders
          // are enough to debug a query.
          logQueryParameters: false,

          ssl: config.get('ORDER_DB_SSL', { infer: true }),

          pool: {
            // A connection pool bounds how much concurrency reaches Postgres.
            // Without a cap, a traffic spike opens connections until the
            // server refuses them, and the database — not the app — falls over.
            max: 10,
            min: 0,
            // Fail a checkout after 10s rather than queueing forever, so a
            // stalled database surfaces as an error instead of a hang.
            acquire: 10_000,
            idle: 10_000,
          },
        };
      },
    }),
  ],
})
export class DatabaseModule implements OnModuleInit {
  private readonly logger = new Logger('Database');

  constructor(private readonly sequelize: Sequelize) {}

  /**
   * Proves the connection at boot instead of assuming it.
   *
   * SequelizeModule opens a pool eagerly, but a pool that failed to connect
   * does not necessarily stop the process. authenticate() forces a round trip,
   * and asking the server to identify itself means the log shows WHICH
   * database and WHICH role we are actually attached to — the two things
   * people most often get wrong when several services share one Postgres
   * instance. This service must be attached to the ORDER database and to
   * no other.
   */
  async onModuleInit(): Promise<void> {
    await this.sequelize.authenticate();

    // QueryTypes.SELECT makes query() resolve to the rows themselves. Without
    // it Sequelize resolves to a [rows, metadata] tuple, which is where the
    // "why is my result an array of arrays" confusion comes from.
    const rows = await this.sequelize.query<ConnectionFacts>(
      `select version() as "version",
              current_database() as "database",
              current_user as "role"`,
      { type: QueryTypes.SELECT, raw: true },
    );

    const row = rows[0];
    if (row === undefined) {
      throw new Error('Database connection check returned no rows');
    }

    this.logger.log(
      `connected to "${row.database}" as role "${row.role}" — ${row.version.split(',')[0]}`,
    );
  }
}

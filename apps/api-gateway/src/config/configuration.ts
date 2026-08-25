/**
 * Maps validated environment variables onto a typed configuration object.
 *
 * Consumers read `configService.get('http.port')` instead of touching
 * `process.env` directly, which keeps `process.env` access in exactly one
 * place and makes the shape of our configuration explicit and testable.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  http: {
    port: number;
    globalPrefix: string;
  };
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV as AppConfig['nodeEnv'],
  http: {
    port: Number(process.env.PORT),
    globalPrefix: String(process.env.API_GLOBAL_PREFIX),
  },
});

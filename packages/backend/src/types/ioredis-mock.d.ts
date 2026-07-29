// ioredis-mock ships no type declarations. It is only used in tests, always cast to the
// real RedisClient surface, so a bare module declaration is enough to satisfy tsc.
declare module "ioredis-mock";

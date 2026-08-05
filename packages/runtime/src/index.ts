/**
 * The application runtime.
 *
 * One path from configuration to a usable repository, so that no handler, service,
 * engine or job decides how persistence is obtained.
 */
export * from './config';
export * from './persistence-runtime';

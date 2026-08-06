import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenancy scope a database operation runs under.
 *
 * Row Level Security reads `app.tenant_id`, `app.workspace_id` and `app.actor_id`, so
 * something has to set them. `TrustPersistence` takes no context — `list(collection)` is
 * the whole signature — and adding one would change every method and every call site in
 * the platform for a second time.
 *
 * So the scope is ambient, carried by `AsyncLocalStorage` from the composition root, which
 * already resolves a `RequestContext` for every protected route in one place. The store
 * reads it and issues transaction-local `set_config` before each statement.
 *
 * Ambient state is a real cost and worth naming: a call made outside a scope gets none,
 * and under forced RLS reads nothing. That is the correct failure — an unscoped governed
 * read must return nothing rather than everything — but it means a path that forgets to
 * establish scope fails at the database rather than at the type level. `withTrustScope` is
 * therefore applied at the funnel every protected route passes through, not at call sites.
 */

export type TrustScope = {
  tenantId?: string;
  workspaceId?: string;
  actorId?: string;
};

const storage = new AsyncLocalStorage<TrustScope>();

/**
 * Runs `operation` with `scope` visible to every database call it makes, including ones
 * inside promises it awaits.
 *
 * Nested calls replace the scope rather than merging it. Merging would let an inner
 * operation inherit a tenant the caller did not set and quietly widen what it can read;
 * replacing means an inner scope is exactly what its caller stated.
 */
export function withTrustScope<T>(scope: TrustScope, operation: () => Promise<T>): Promise<T> {
  return storage.run(scope, operation);
}

/** The ambient scope, or undefined outside one. */
export function currentTrustScope(): TrustScope | undefined {
  return storage.getStore();
}

/**
 * Runs `operation` with no scope at all.
 *
 * For work that legitimately spans tenants and must not inherit a caller's scope by
 * accident: the migration runner, a schema check, an operator tool. Under forced RLS such a
 * connection reads nothing through a policy-governed table, which is why these paths connect
 * as the owning role rather than as the application.
 *
 * Deliberately not named `withoutRls` or similar. It removes scope; it does not grant
 * exemption, and nothing in the application can grant itself one.
 */
export function withoutTrustScope<T>(operation: () => Promise<T>): Promise<T> {
  return storage.run({}, operation);
}

/**
 * Sets the scope for the remainder of the current async context, with no callback.
 *
 * `withTrustScope` needs to wrap the work, which a Next.js route handler's shape does not
 * allow without editing all 161 of them: a handler resolves its context and then does its
 * work as straight-line code. `enterWith` sets the store for the rest of the async context
 * the request is already running in, so the funnel that resolves the context can also
 * establish the scope.
 *
 * The tradeoff, stated rather than hidden: `enterWith` mutates the current context instead of
 * creating a child, so a caller that shares an async context across requests would share the
 * scope too. That is safe here because each HTTP request runs in its own async context —
 * which is precisely the assumption to re-check before using this anywhere else. Prefer
 * `withTrustScope` wherever the work can be wrapped.
 */
export function enterTrustScope(scope: TrustScope): void {
  storage.enterWith(scope);
}

/** Whether a scope carries enough to satisfy a tenant-scoped policy. */
export function isTenantScoped(scope: TrustScope | undefined): scope is TrustScope & { tenantId: string } {
  return typeof scope?.tenantId === 'string' && scope.tenantId.length > 0;
}

import { getPersistenceRuntime } from '../../../../lib/persistence';

/**
 * Readiness: can this host execute protected work safely.
 *
 * Answers from a live check rather than a startup snapshot. A database that was reachable
 * at boot can be gone by the next request, and a probe answering from cache reports
 * healthy straight through an outage.
 *
 * 503 while initializing, unreachable, schema-incompatible, or shutting down — so an
 * orchestrator stops routing to a host that cannot record what it is asked to do, instead
 * of that host accepting governed mutations it cannot audit.
 *
 * The body carries a code and a sanitized detail. No connection string, no credential, no
 * internal hostname: a readiness endpoint is often reachable without authentication, and
 * an internal host name is a fact about the deployment a probe has no reason to publish.
 */
export async function GET(): Promise<Response> {
  try {
    const runtime = await getPersistenceRuntime();
    const readiness = await runtime.checkReadiness();

    return Response.json(
      {
        ready: readiness.ready,
        code: readiness.code,
        detail: readiness.detail,
        adapter: runtime.adapter,
        deployment: runtime.config.deployment,
        runtimeId: runtime.runtimeId,
        checkedAt: readiness.checkedAt,
      },
      { status: readiness.ready ? 200 : 503 },
    );
  } catch (error) {
    // A runtime that failed to initialize is not ready, and the reason is a
    // configuration or startup code — never the underlying error text, which may quote a
    // connection string.
    const code =
      error instanceof Error && /^[A-Z_]+:/.test(error.message)
        ? error.message.split(':')[0]
        : 'RUNTIME_UNAVAILABLE';
    return Response.json(
      { ready: false, code, checkedAt: new Date().toISOString() },
      { status: 503 },
    );
  }
}

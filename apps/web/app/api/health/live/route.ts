/**
 * Liveness: is this process running.
 *
 * Deliberately says nothing about the database, and deliberately does no I/O. Conflating
 * liveness with readiness makes an orchestrator kill and restart a perfectly healthy
 * process because its database blinked — which loses in-flight work and does nothing to
 * fix the database.
 *
 * No configuration, no adapter, no runtime identity: this endpoint exists to be
 * unauthenticated, so it publishes nothing.
 */
export async function GET(): Promise<Response> {
  return Response.json({ alive: true }, { status: 200 });
}

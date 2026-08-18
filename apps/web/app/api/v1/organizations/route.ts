import { authorizedContextForRoute, errorResponse, trust } from '../../../../lib/trust-app';

/**
 * Registers an organization inside the caller's active workspace.
 *
 * Re-pointed from `AssuraPayService.createOrganization` over `FileAssuraStore` to
 * `OrganizationService.createOrganization`, which writes `trustOrganizations` durably and enforces three
 * things the file-backed path did not: the workspace must exist, it must be an `ORGANIZATION` workspace
 * rather than a personal one, and the caller must hold an active membership in it. It also tokenises a tax
 * identifier rather than storing it, which CLAUDE.md's trust-foundation boundary requires of a sensitive
 * value.
 *
 * The legacy record was `{ id, name, tenantId, createdAt }`. The durable aggregate carries the legal name,
 * organization type, industry, business size, country and registered address, because those are what the
 * verification and party engines read. The body is passed through rather than mapped, so a caller supplies
 * the aggregate's own fields and the engine validates them; a mapping layer here would have to invent
 * values for fields the legacy shape has no source for.
 */
export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(
      await trust.organizations.createOrganization(context, await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

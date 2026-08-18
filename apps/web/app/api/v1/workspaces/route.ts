import {
  authorizedContextForRoute,
  errorResponse,
  trust,
  workspaceScoped,
} from '../../../../lib/trust-app';

/**
 * Creates a further workspace inside the caller's existing tenant.
 *
 * Re-pointed from `AssuraPayService.createWorkspace` over `FileAssuraStore` — a JSON file that refuses in
 * every durable deployment — to `OrganizationService.createWorkspace`, which appends `trustWorkspaces`, the
 * caller's `OWNER` membership, an audit record and a domain event, all durably and inside the tenancy
 * boundary.
 *
 * The tenant comes from the authorized context and is never read from the body: a body-supplied tenant let
 * any caller create a workspace inside any tenant, and it is also the value the ambient trust scope is
 * already set to, so a different one would be refused by row-level security rather than honoured.
 *
 * Founding a caller's *first* tenant and workspace is `POST /v1/tenants`, which is identity-class because
 * `workspaces:create` cannot be granted before a workspace exists to hold the grant.
 */
export async function POST(request: Request) {
  try {
    const context = workspaceScoped(await authorizedContextForRoute(request));
    const body = (await request.json()) as {
      name?: string;
      slug?: string;
      workspaceType?: 'PERSONAL' | 'ORGANIZATION';
      defaultCurrency?: string;
      timezone?: string;
      countryCode?: string;
    };

    const workspace = await trust.organizations.createWorkspace({
      tenantId: context.tenantId,
      workspaceType: body.workspaceType ?? 'ORGANIZATION',
      name: body.name ?? '',
      slug: body.slug ?? '',
      ownerUserId: context.actorUserId,
      defaultCurrency: body.defaultCurrency ?? 'NGN',
      timezone: body.timezone ?? 'Africa/Lagos',
      countryCode: body.countryCode ?? 'NG',
      correlationId: context.correlationId,
    });

    return Response.json(workspace, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

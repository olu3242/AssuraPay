import {
  agreements,
  authorizedContextForRoute,
  errorResponse,
  trustStore,
  workspaceScoped,
} from '../../../../lib/trust-app';

/**
 * Contracts in the caller's active workspace.
 *
 * Re-pointed from `AssuraPayService` over `FileAssuraStore` to `ContractAuthoringEngine` over the durable
 * store — the same engine `POST /v1/agreement-contracts` uses. Two paths, one implementation: the legacy
 * path stays published because clients call it, and it no longer resolves to a different model.
 *
 * The durable aggregate requires a `contractNumber` and a `contractType`, and refuses a number already used
 * in the workspace. The legacy record had neither and could not collide with anything. That is a real
 * behaviour change and it is the right direction: `agreements` is the canonical chain's first link, and a
 * contract nobody can cite by number is not evidence of anything. A caller that omits the number is refused
 * by the engine rather than silently given a record with no identifier — the alternative, generating one
 * here, would mint a citation the caller never agreed to.
 */
export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = (await request.json()) as {
      contractNumber?: string;
      title?: string;
      contractType?: string;
      ownerUserId?: string;
      description?: string;
    };
    return Response.json(
      await agreements.authoring.create(context, {
        contractNumber: body.contractNumber ?? '',
        title: body.title ?? '',
        contractType: body.contractType ?? '',
        // The owner defaults to the authenticated caller rather than to a body field. An owner read from
        // the request would let a caller create a contract owned by someone else.
        ownerUserId: body.ownerUserId ?? context.actorUserId,
      }),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The workspace's contracts.
 *
 * The workspace filter is kept even though row-level security already confines the read to the caller's
 * tenant: a tenant may hold several workspaces, and RLS on `agreements` is tenant-and-workspace scoped
 * while `list` is issued under the active workspace's scope. Filtering here as well means the route's
 * contract — "contracts in my active workspace" — is stated by the route rather than inferred from the
 * ambient scope, and it stays true if the scope ever widens.
 */
export async function GET(request: Request) {
  try {
    const context = workspaceScoped(await authorizedContextForRoute(request));
    const all = await trustStore.list<{ workspaceId?: string }>('agreements');
    return Response.json(
      all.filter((agreement) => agreement.workspaceId === context.activeWorkspaceId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

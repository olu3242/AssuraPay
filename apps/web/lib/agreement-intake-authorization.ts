import type { RequestContext } from '@assurapay/shared';
import { authorizedContext } from './trust-app';

/** Agreement intake intentionally reuses the canonical agreement permission family. */
export function authorizeAgreementIntakeWrite(request: Request): Promise<RequestContext> {
  return authorizedContext(request, { permissionKey: 'agreement-contracts:create' });
}

export function authorizeAgreementIntakeRead(request: Request): Promise<RequestContext> {
  return authorizedContext(request, { permissionKey: 'contracts:read' });
}

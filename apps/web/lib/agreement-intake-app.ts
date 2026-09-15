import { ContractAuthoringEngine } from '@assurapay/agreement-creation';
import { AgreementIntakeConvergenceService, AgreementIntakeEngine, type CanonicalAgreementAuthoringPort } from '@assurapay/agreement-intelligence';
import type { RequestContext } from '@assurapay/shared';
import { trustStore } from './persistence';

const authoring = new ContractAuthoringEngine(trustStore);

const authoringPort: CanonicalAgreementAuthoringPort = {
  async create(context: RequestContext, input) {
    try {
      const agreement = await authoring.create(context, {
        contractNumber: input.contractNumber,
        title: input.title,
        contractType: input.contractType,
        ownerUserId: input.ownerUserId,
      });
      await trustStore.audit({
        tenantId: context.tenantId,
        workspaceId: context.activeWorkspaceId,
        actorId: context.actorUserId,
        eventType: 'AgreementIntakeConvertedToDraft',
        aggregateType: 'Agreement',
        aggregateId: agreement.id,
        correlationId: context.correlationId,
        metadata: { ...input.provenance, idempotencyKey: input.idempotencyKey },
      });
      return agreement;
    } catch (error) {
      if (error instanceof Error && error.message === 'CONTRACT_NUMBER_EXISTS') {
        const existing = (await trustStore.list<any>('agreements')).find(
          (item) => item.workspaceId === context.activeWorkspaceId && item.contractNumber === input.contractNumber,
        );
        if (existing) return existing;
      }
      throw error;
    }
  },
};

export const agreementIntakes = new AgreementIntakeEngine(trustStore);
export const agreementIntakeConvergence = new AgreementIntakeConvergenceService(agreementIntakes, authoringPort);

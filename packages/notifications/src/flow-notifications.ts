import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { NotificationEngine } from './index';
import type { NotificationTemplateId } from './templates';

/**
 * Turns changes in the flow process into notifications.
 *
 * The gap this closes is specific. `FlowOrchestrator.dispatch` creates a `HumanTask` with a
 * `requiredRole` and nobody is told it exists — including for the canonical journey's
 * `enhanced-approval` step, which is the decision that gates releasing money. A journey reached
 * `WAITING_HUMAN` and waited in silence for a person who had no way of knowing.
 *
 * ## Who gets told is who may act
 *
 * Recipients for a human task are resolved with the **same predicate `FlowOrchestrator.decide` uses
 * to authorize one**: an active membership in the workspace whose `role` or `membershipType` matches
 * the task's `requiredRole`. Reusing it rather than writing a second rule means a notification can
 * never reach someone who would be refused when they acted on it, and that the two cannot drift
 * apart — a notification rule that was subtly broader than the authorization rule would be an
 * information leak dressed as a convenience.
 *
 * Flow lifecycle notifications go to the journey's initiator, who is the one person the record
 * names as having started it.
 *
 * ## Why this reads state rather than consuming events
 *
 * Every notification's idempotency key names the thing that happened —
 * `human-task:{id}:raised`, `flow:{id}:SUSPENDED` — so dispatching repeatedly is a no-op and the
 * dispatcher can be as dumb as a scan. Consuming the outbox instead would have meant draining a
 * stream whose events Flow OS also needs, and two consumers of one append-only log with no cursor
 * is how one of them starts missing events.
 */

type FlowInstanceRecord = {
  id: string;
  workspaceId: string;
  state: string;
  initiatorId: string;
  transactionId: string;
  flowDefinitionId: string;
};

type HumanTaskRecord = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepInstanceId: string;
  requiredRole: string;
  status: string;
};

type StepInstanceRecord = {
  id: string;
  workspaceId: string;
  stepDefinitionId: string;
};

type MembershipRecord = {
  workspaceId: string;
  userId: string;
  status: string;
  role?: string;
  membershipType?: string;
};

type IdentityRecord = { id: string; displayName: string };

/** Flow states a journey's initiator is told about. Steady-state progress is not news. */
const NOTIFIED_STATES: Record<string, NotificationTemplateId> = {
  SUSPENDED: 'flow-suspended',
  FAILED: 'flow-failed',
  COMPLETED: 'flow-completed',
};

export type FlowNotificationResult = {
  /** Notifications newly raised. Repeat runs report zero. */
  raised: number;
  /** Open human tasks found with nobody holding their required role. */
  unroutable: Array<{ taskId: string; requiredRole: string }>;
};

/**
 * Resolves a step's human title from its definition.
 *
 * Injected rather than imported: the titles live in `FlowDefinition`, and having this package depend
 * on `flow-orchestration` to read them would couple the notification engine to the orchestrator for
 * one string. The composition root supplies a resolver backed by the same registry the orchestrator
 * uses, so the email names the step the way the product does.
 */
export type StepTitleResolver = (input: {
  flowDefinitionId: string;
  stepDefinitionId: string;
}) => string | undefined;

/**
 * Turns `enhanced-approval` into `Enhanced approval`.
 *
 * The fallback when no resolver is supplied. Not ideal — the definition's own title is better — but
 * far better than mailing somebody an internal slug, which is what the first version of this did.
 */
export function humaniseStepId(stepDefinitionId: string): string {
  const words = stepDefinitionId.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'an execution step';
}

export class FlowNotificationDispatcher {
  constructor(
    private readonly store: TrustPersistence,
    private readonly notifications: NotificationEngine,
    private readonly resolveStepTitle?: StepTitleResolver,
  ) {}

  /**
   * Raises a notification for every change in this workspace's flows that warrants one.
   *
   * Idempotent, so a scheduler may call it on every tick. It raises obligations only — delivery is
   * `NotificationEngine.deliverPending`, so a transport outage cannot make this fail.
   */
  async dispatch(context: RequestContext, options: { flowId?: string } = {}): Promise<FlowNotificationResult> {
    requireActiveWorkspace(context);
    const workspaceId = context.activeWorkspaceId;

    const flows = (await this.store.list<FlowInstanceRecord>('flowInstances')).filter(
      (flow) =>
        flow.workspaceId === workspaceId && (options.flowId === undefined || flow.id === options.flowId),
    );
    const byId = new Map(flows.map((flow) => [flow.id, flow]));

    let raised = 0;
    const unroutable: FlowNotificationResult['unroutable'] = [];

    // Human tasks first: a waiting approval is the most time-sensitive thing here, and the whole
    // reason the engine exists.
    const steps = await this.store.list<StepInstanceRecord>('flowStepInstances');
    const stepTitles = new Map(
      steps.filter((step) => step.workspaceId === workspaceId).map((step) => [step.id, step.stepDefinitionId]),
    );

    for (const task of await this.store.list<HumanTaskRecord>('humanTasks')) {
      if (task.workspaceId !== workspaceId || task.status !== 'OPEN') continue;
      const flow = byId.get(task.flowInstanceId);
      if (!flow) continue;

      const recipients = await this.holdersOfRole(workspaceId, task.requiredRole);
      if (recipients.length === 0) {
        // Reported rather than swallowed. A journey blocked on a role nobody holds is a
        // configuration fault that looks exactly like a slow approver from the outside.
        unroutable.push({ taskId: task.id, requiredRole: task.requiredRole });
        continue;
      }

      for (const recipient of recipients) {
        const record = await this.notifications.raise(context, {
          recipientIdentityId: recipient,
          templateId: 'human-task-raised',
          variables: {
            recipientName: await this.displayName(recipient),
            stepTitle: this.stepTitle(flow.flowDefinitionId, stepTitles.get(task.stepInstanceId)),
            requiredRole: task.requiredRole,
            flowReference: this.reference(flow),
            // The page that holds this decision, with the task marked in the recipient's own
            // inbox. A path, not a URL: see the note on SIGN_OFF in templates.ts.
            actionPath: `/approvals?task=${task.id}`,
          },
          subjectType: 'HumanTask',
          subjectId: task.id,
          // Per recipient, so adding a second approver later notifies only the new one.
          idempotencyKey: `human-task:${task.id}:raised:${recipient}`,
        });
        if (record) raised++;
      }
    }

    for (const flow of flows) {
      const templateId = NOTIFIED_STATES[flow.state];
      if (!templateId) continue;

      const record = await this.notifications.raise(context, {
        recipientIdentityId: flow.initiatorId,
        templateId,
        variables: {
          recipientName: await this.displayName(flow.initiatorId),
          flowReference: this.reference(flow),
          // The orchestrator keeps the suspension reason on its transition record rather than the
          // instance, and a notification must not invent one it cannot read.
          reason: 'see the journey record',
        },
        subjectType: 'FlowInstance',
        subjectId: flow.id,
        // Keyed on the state, so a journey suspended, resumed and suspended again notifies once per
        // distinct outcome rather than once per scan.
        idempotencyKey: `flow:${flow.id}:${flow.state}`,
      });
      if (record) raised++;
    }

    return { raised, unroutable };
  }

  private stepTitle(flowDefinitionId: string, stepDefinitionId: string | undefined): string {
    if (!stepDefinitionId) return 'an execution step';
    return (
      this.resolveStepTitle?.({ flowDefinitionId, stepDefinitionId }) ?? humaniseStepId(stepDefinitionId)
    );
  }

  /** The predicate `FlowOrchestrator.decide` authorizes with, used here to choose recipients. */
  private async holdersOfRole(workspaceId: string, requiredRole: string): Promise<string[]> {
    return [
      ...new Set(
        (await this.store.list<MembershipRecord>('memberships'))
          .filter(
            (membership) =>
              membership.workspaceId === workspaceId &&
              membership.status === 'ACTIVE' &&
              (membership.role === requiredRole || membership.membershipType === requiredRole),
          )
          .map((membership) => membership.userId),
      ),
    ].sort();
  }

  private async displayName(identityId: string): Promise<string> {
    const identity = (await this.store.list<IdentityRecord>('identities')).find(
      (entry) => entry.id === identityId,
    );
    // Falls back rather than throwing: a missing display name must not stop an approval being
    // chased. `raise` still refuses an identity that does not exist at all.
    return identity?.displayName?.trim() || 'there';
  }

  /**
   * A human-readable journey reference that is not a raw id.
   *
   * The transaction id is the thing a person can match against their own records, and it is already
   * theirs — unlike the flow's UUID, which means nothing outside the platform.
   */
  private reference(flow: FlowInstanceRecord): string {
    return `${flow.flowDefinitionId} / ${flow.transactionId}`;
  }
}

import { ApprovalInboxConsole } from '../components/approval-inbox';

/**
 * Approvals.
 *
 * This page was a heading and a sentence — "Approval queue · Version-pinned routes enforce
 * authority, step-up assurance and requester segregation" — with no queue. It is also where the
 * Engine 09 notification emails send a release approver, so "a release approval is waiting for you"
 * led to a page that showed no approvals.
 *
 * `searchParams.task` lets a notification deep-link to one approval and have it marked in the list.
 * It only highlights: the inbox is still the caller's own, scoped by their own assertion, so a link
 * to someone else's task shows them their queue rather than that task.
 */
export default function ApprovalsPage({
  searchParams,
}: {
  searchParams?: { task?: string };
}) {
  return (
    <main className="shell">
      <p className="eyebrow">Approvals</p>
      <h1>Waiting for your decision</h1>
      <p className="lead">
        Releasing money needs a person. Each item below is an execution step that cannot continue
        until someone with the right role decides, and your decision is recorded against it.
      </p>
      <ApprovalInboxConsole highlightTaskId={searchParams?.task} />
    </main>
  );
}

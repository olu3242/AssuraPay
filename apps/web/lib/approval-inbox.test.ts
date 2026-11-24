import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * The approval inbox offers no action its decision would refuse.
 *
 * `/approvals` was a heading and a sentence with no queue, and it is where the Engine 09 emails send
 * a release approver — so "a release approval is waiting for you" led to a page showing no
 * approvals. The screen now reads the caller's own queue.
 *
 * These assertions guard the two properties that make it safe rather than merely present. The
 * authorization rule is the important one: `getApprovalInbox` marks an entry `actionable` using the
 * same membership predicate `FlowOrchestrator.decide` authorizes with, and the component renders
 * buttons only for actionable entries. A screen that offered an Approve button to someone the
 * decision would then reject is worse than one that offered nothing, because it teaches people that
 * the buttons lie.
 *
 * The behavioural proof of the projection itself is `approval-inbox.postgres.test.ts`, which runs it
 * against a real database with row-level security in force. What can only be checked by reading the
 * source is checked here.
 */

const LIB = __dirname;
const APP = path.join(__dirname, '..', 'app');

/** Source with comments stripped, so these checks are about code and not about documentation. */
function read(relative: string, root = LIB): string {
  return readFileSync(path.join(root, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the inbox is scoped to the caller and to their role', () => {
  it('computes actionable from an active membership matching the required role', () => {
    // The same three conditions `decide` checks: right workspace, right user, ACTIVE — and the role
    // matched on either `role` or `membershipType`, because the orchestrator accepts both.
    const source = read('flow-operations.ts');
    expect(source).toContain('membership.userId === context.actorUserId');
    expect(source).toContain("membership.status === 'ACTIVE'");
    expect(source).toContain('membership.role');
    expect(source).toContain('membership.membershipType');
    expect(source).toContain('myRoles.has(task.requiredRole)');
  });

  it('filters every read by the caller’s active workspace', () => {
    const source = read('flow-operations.ts');
    const inbox = source.slice(source.indexOf('export async function getApprovalInbox'));
    // Tasks, flows, steps and memberships are all workspace-filtered. A projection that joined an
    // unfiltered flow onto a scoped task would leak a transaction id across the boundary.
    expect((inbox.match(/=== workspace/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('counts approvals belonging to others rather than listing or hiding them', () => {
    // Hiding them makes a queue look empty when it is merely not yours, which is the confusion that
    // leaves a release waiting. Listing them exposes work the reader cannot act on.
    const source = read('flow-operations.ts');
    expect(source).toContain('waitingOnOthers++');
    const inbox = source.slice(source.indexOf('export async function getApprovalInbox'));
    // The non-actionable branch increments and then stops, so no entry is pushed for it.
    expect(inbox).toMatch(/if \(!actionable\) \{\s*waitingOnOthers\+\+;\s*continue;/);
  });

  it('skips a task whose flow is not visible in the workspace', () => {
    const source = read('flow-operations.ts');
    expect(source).toMatch(/if \(!flow\) continue;/);
  });
});

describe('the screen mints one assertion per call', () => {
  const component = read('approval-inbox.tsx', path.join(APP, 'components'));

  it('never reuses an assertion across calls', () => {
    // The gateway authenticates only a signed assertion, and the design intends an acting path to
    // consume it so one assertion authorises one action. No route is wired to the consuming context
    // yet, so a cached assertion would currently be accepted again — minting per call is therefore
    // the behaviour that stays correct once it is, rather than one that depends on it today.
    expect(component).toContain("fetch('/api/v1/auth/assertion'");
    // No module- or component-level cache of the header value.
    expect(component).not.toMatch(/const \[?assertion\]?\s*=\s*useState/);
    expect(component).not.toMatch(/useRef<[^>]*assertion/i);
  });

  it('reads identity from the session route, never from a cookie or header it sets itself', () => {
    // Reading identity from a header was recorded as "a complete authentication and authorization
    // bypass on every route that used it", so the client must not try.
    expect(component).toContain("fetch('/api/v1/auth/session'");
    expect(component).not.toMatch(/document\.cookie/);
    expect(component).not.toMatch(/localStorage|sessionStorage/);
  });

  it('renders a decision button only for an entry the server marked actionable', () => {
    // `getApprovalInbox` only emits actionable entries, so the component must not re-derive
    // permission or render a button from any other signal.
    expect(component).toContain('onClick={() => void decide(entry');
    expect(component).not.toMatch(/entry\.actionable\s*\?\s*</);
  });
});

describe('the screen shows no figure it did not read', () => {
  const component = read('approval-inbox.tsx', path.join(APP, 'components'));

  it('distinguishes loading, signed-out, forbidden, error and ready', () => {
    // "Nothing is waiting for you" and "we could not find out" are different facts, and conflating
    // them is how a person misses an approval.
    for (const phase of ['loading', 'signed-out', 'forbidden', 'error', 'ready'])
      expect(component, phase).toContain(`'${phase}'`);
  });

  it('renders no hard-coded count or percentage', () => {
    expect(component).not.toMatch(/['"`]\s*\d{1,3}%/);
    expect(component).not.toMatch(/(health|readiness|adherence)\s*[:=]\s*['"`]?\d/i);
  });
});

describe('the route is governed', () => {
  it('gates the inbox on a permission, and deciding on a different one', () => {
    const inbox = ROUTE_PERMISSION_REQUIREMENTS['/api/v1/approvals|GET'];
    expect(inbox?.access).toBe('permission');
    expect(inbox).toMatchObject({ permissionKey: 'executions:read' });

    const decide = ROUTE_PERMISSION_REQUIREMENTS['/api/v1/flow-tasks/[id]/decisions|POST'];
    expect(decide?.access).toBe('permission');
    // Reading the queue and deciding an item in it are different authorities, and the decision key
    // is kept apart from payment execution by a segregation rule.
    expect(decide).toMatchObject({ permissionKey: 'authorization-decisions:approve' });
    expect(decide && 'segregatedFrom' in decide ? decide.segregatedFrom : []).toContain(
      'payment-instructions:submit',
    );
  });
});

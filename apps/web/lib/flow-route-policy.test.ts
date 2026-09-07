import { describe, expect, it } from 'vitest';
import { catalogueKeys } from '@assurapay/permissions';
import { FLOW_ROUTE_POLICY } from './flow-route-policy';

describe('Flow OS HTTP governance bindings', () => {
  it('binds every Flow OS action to a registered canonical permission', () => {
    const registered = new Set(catalogueKeys());
    for (const requirement of Object.values(FLOW_ROUTE_POLICY)) {
      expect(registered.has(requirement.permissionKey), requirement.permissionKey).toBe(true);
    }
  });

  it('uses execution permissions for orchestration mutations', () => {
    expect(FLOW_ROUTE_POLICY.start.permissionKey).toBe('executions:create');
    expect(FLOW_ROUTE_POLICY.signal.permissionKey).toBe('executions:transition');
    expect(FLOW_ROUTE_POLICY.suspend.permissionKey).toBe('executions:transition');
    expect(FLOW_ROUTE_POLICY.resume.permissionKey).toBe('executions:transition');
  });

  it('preserves segregation between release approval and payment submission', () => {
    expect(FLOW_ROUTE_POLICY.decide).toMatchObject({
      permissionKey: 'authorization-decisions:approve',
      segregatedFrom: ['payment-instructions:submit'],
    });
  });
});

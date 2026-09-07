import type { PermissionRequirement } from '@assurapay/permissions';

/**
 * Flow OS reuses the canonical execution/authorization permission vocabulary in
 * this slice instead of inventing unregistered permission keys. These bindings
 * are intentionally explicit so a future dedicated `flows:*` catalogue migration
 * can be reviewed as a policy change rather than hidden inside route code.
 */
export const FLOW_ROUTE_POLICY = {
  start: { permissionKey: 'executions:create' },
  signal: { permissionKey: 'executions:transition' },
  suspend: { permissionKey: 'executions:transition' },
  resume: { permissionKey: 'executions:transition' },
  decide: {
    permissionKey: 'authorization-decisions:approve',
    segregatedFrom: ['payment-instructions:submit'],
  },
} as const satisfies Record<string, PermissionRequirement>;

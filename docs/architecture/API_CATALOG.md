# API Catalog

## Workspace and organization
- POST /api/v1/workspaces
- POST /api/v1/organizations
- GET /api/v1/me/workspaces

## Contract and milestone workflow
- POST /api/v1/contracts
- GET /api/v1/contracts
- POST /api/v1/contracts/{id}/approve
- GET /api/v1/milestones/{id}/assurance
- GET /api/v1/completion-certificates/{id}/verify
- GET /api/v1/payment-eligibility/{id}/blockers

## Trust foundation
- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/logout
- GET /api/v1/auth/session
- POST /api/v1/workspaces/{id}/activate-context
- POST /api/v1/permissions/evaluate
- POST /api/v1/parties
- POST /api/v1/parties/{id}/verification-requests
- POST /api/v1/legal/policies
- POST /api/v1/legal/policy-versions/{id}/accept
- POST /api/v1/legal/holds

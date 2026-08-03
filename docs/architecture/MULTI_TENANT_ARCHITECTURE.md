# Multi-Tenant Architecture

`OrganizationService` creates personal or organization workspaces and an explicit owner membership. Active context is resolved only after an active membership check. Tenant records use workspace ownership; hierarchy moves reject cycles. PostgreSQL policies compare `app.workspace_id` and `app.actor_id` against active memberships.

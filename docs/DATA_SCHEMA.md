# Canonical Data Architecture — AssuraPay

Postgres is the target store. Monetary values use integer minor units and ISO 4217 currencies. Timestamps use UTC. Every tenant-owned table includes `tenant_id`, `workspace_id`, audit timestamps, actor references and an optimistic record version where mutation is allowed.

## 1. Workspace and governance core

- `users`
- `workspaces` (`personal`, `organization`)
- `workspace_memberships`
- `organizations`
- `organization_units`
- `parties`
- `party_verifications`
- `roles`
- `permission_sets`
- `object_permissions`
- `record_access_rules`
- `field_permissions`
- `delegations`
- `authority_rules`

## 2. Configuration and metadata core

- `configuration_profiles`
- `configuration_settings`
- `configuration_assignments`
- `effective_configuration_snapshots`
- `object_definitions`
- `field_definitions`
- `custom_object_definitions`
- `custom_field_definitions`
- `layout_definitions`
- `workflow_definitions`
- `workflow_states`
- `workflow_transitions`
- `rule_definitions`
- `configuration_change_requests`

## 3. Agreement intelligence core

- `contracts`
- `contract_versions`
- `contract_documents`
- `clauses`
- `clause_versions`
- `contract_clause_instances`
- `negotiation_sessions`
- `redlines`
- `approval_requests`
- `approval_decisions`
- `signature_packets`
- `signature_events`
- `contract_risk_assessments`
- `agreement_extractions`

## 4. Performance Blueprint core

- `performance_blueprints`
- `blueprint_versions`
- `scope_items`
- `milestones`
- `deliverables`
- `definition_of_done_packages`
- `acceptance_criteria`
- `evidence_requirements`
- `quality_gates`
- `compliance_gates`
- `risk_gates`
- `dependencies`
- `success_metrics`
- `payment_triggers`
- `performance_baselines`

## 5. Execution assurance core

- `execution_workspaces`
- `work_items`
- `progress_records`
- `evidence_items`
- `evidence_packages`
- `validation_plans`
- `validation_tests`
- `quality_plans`
- `quality_reviews`
- `defects`
- `inspections`
- `inspection_findings`
- `execution_issues`
- `corrective_actions`
- `change_requests`
- `change_impact_assessments`
- `acceptance_requests`
- `acceptance_decisions`
- `completion_eligibility_assessments`
- `completion_certificates`

## 6. Settlement assurance core

- `payment_eligibility_records`
- `financial_entitlements`
- `entitlement_lines`
- `invoices`
- `invoice_lines`
- `funding_commitments`
- `escrow_account_references`
- `fund_reservations`
- `settlement_holds`
- `retention_records`
- `release_requests`
- `release_condition_results`
- `financial_approval_decisions`
- `payment_rails`
- `payment_instructions`
- `payment_transactions`
- `settlement_ledger_entries`
- `reconciliation_records`
- `settlement_disputes`
- `dispute_positions`
- `dispute_decisions`
- `appeals`
- `final_settlement_assessments`
- `final_settlement_statements`
- `financial_closure_certificates`

## 7. Intelligence and AI core

- `kpi_definitions`
- `kpi_results`
- `assurance_scores`
- `forecasts`
- `alerts`
- `ai_prompts`
- `ai_models`
- `ai_policies`
- `ai_recommendations`
- `ai_evaluations`
- `ai_feedback`

## 8. Reliability and audit core

- `audit_events` — append-only and hash-linked where required
- `domain_outbox`
- `consumer_inbox`
- `dead_letter_events`
- `notification_deliveries`
- `webhook_deliveries`
- `integration_connections`
- `provider_callbacks`

No update or delete privilege is granted to normal application roles on append-only audit and ledger tables. Corrections use compensating entries.

## 9. Key aggregate relationships

```text
workspace
  └── contract
       └── contract_version
            └── performance_blueprint
                 └── milestone
                      ├── definition_of_done_package
                      ├── execution_workspace
                      │    ├── work_items
                      │    ├── progress_records
                      │    ├── evidence_package
                      │    ├── validation_tests
                      │    ├── issues/corrective_actions
                      │    └── acceptance_decision
                      └── completion_certificate
                           └── payment_eligibility
                                └── financial_entitlement
                                     ├── invoice
                                     ├── fund_reservation
                                     └── release_request
                                          └── payment_instruction
                                               └── payment_transaction
                                                    └── reconciliation_record
```

## 10. Legacy migration

The former `assurance_requests` table must not remain the universal write model. Migrate it into one of two forms:

1. A compatibility/read projection named `assurance_cases`; or
2. A legacy import table mapped to contract, milestone, condition, release and payment aggregates.

Do not allow new engine logic to mutate all lifecycle state through one status column.

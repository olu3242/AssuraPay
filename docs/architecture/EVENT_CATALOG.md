# Event Catalog

The execution-assurance foundation surfaces the following domain events through service state transitions:

- WorkspaceCreated
- OrganizationCreated
- ContractCreated
- ContractApproved
- BlueprintCreated
- MilestoneCreated
- DefinitionOfDoneApproved
- MilestoneActivated
- EvidenceUploaded
- ValidationCompleted
- AcceptanceGranted
- CompletionCertificateIssued
- PaymentEligibilityConfirmed

Trust events use a versioned outbox and include `IdentityRegistered`, `IdentityActivated`, `AuthenticationSucceeded`, `AuthenticationFailed`, `SessionCreated`, `SessionRevoked`, `WorkspaceCreated`, `OrganizationWorkspaceCreated`, `PermissionSetAssigned`, `PermissionDenied`, `SegregationOfDutiesViolationDetected`, `PartyCreated`, `VerificationCompleted`, `VerificationFailed`, `BeneficiaryAccountAdded`, `LegalPolicyPublished`, `PolicyAccepted`, and `LegalHoldPlaced`.

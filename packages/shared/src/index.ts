export type TenantScope = {
  tenantId: string;
  workspaceId: string;
  actorId: string;
};

export type Workspace = {
  id: string;
  name: string;
  type: 'personal' | 'organization';
  tenantId: string;
  createdAt: string;
};

export type Organization = {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
};

export type ContractStatus =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'EXECUTED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'TERMINATED';

export type Contract = {
  id: string;
  workspaceId: string;
  tenantId: string;
  title: string;
  description: string;
  status: ContractStatus;
  version: number;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
};

export type Blueprint = {
  id: string;
  contractId: string;
  workspaceId: string;
  tenantId: string;
  title: string;
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'SUPERSEDED';
  createdAt: string;
};

export type Milestone = {
  id: string;
  blueprintId: string;
  workspaceId: string;
  tenantId: string;
  title: string;
  status: 'PLANNED' | 'READY' | 'ACTIVE' | 'BLOCKED' | 'UNDER_VALIDATION' | 'ACCEPTED' | 'CERTIFIED_COMPLETE';
  dodApproved: boolean;
  dependenciesSatisfied: boolean;
  createdAt: string;
};

export type DefinitionOfDone = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  approved: boolean;
  version: number;
  criteria: string[];
  createdAt: string;
};

export type EvidenceItem = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  title: string;
  status: 'UPLOADED' | 'VERIFIED' | 'REJECTED';
  contentHash: string;
  createdAt: string;
};

export type ValidationResult = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  criterion: string;
  status: 'PASSED' | 'FAILED' | 'RETEST_REQUIRED';
  createdAt: string;
};

export type AcceptanceDecision = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  decision: 'FULL_ACCEPTANCE' | 'REJECTED' | 'CONDITIONAL_ACCEPTANCE';
  decisionMakerId: string;
  createdAt: string;
};

export type CompletionCertificate = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  certificateNumber: string;
  status: 'CERTIFIED' | 'REVOKED';
  integrityHash: string;
  issuedAt: string;
};

export type PaymentEligibilityRecord = {
  id: string;
  milestoneId: string;
  workspaceId: string;
  tenantId: string;
  status: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'CONDITIONAL' | 'REVOKED';
  certificateId?: string;
  createdAt: string;
};

export type AssuranceFactor = {
  id: string;
  label: string;
  weight: number;
  score: number;
  detail: string;
};

export type AssuranceScore = {
  id: string;
  tenantId: string;
  workspaceId: string;
  subject: 'execution' | 'settlement';
  targetId: string;
  score: number;
  maxScore: number;
  summary: string;
  factors: AssuranceFactor[];
  generatedAt: string;
};

export type KpiResult = {
  id: string;
  tenantId: string;
  workspaceId: string;
  metric: string;
  value: number;
  target: number;
  unit: 'score' | 'count' | 'percent';
  trend: 'up' | 'stable' | 'down';
  generatedAt: string;
};

export type DashboardAlert = {
  id: string;
  level: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  generatedAt: string;
};

export type ExecutiveDashboard = {
  tenantId: string;
  workspaceId: string;
  role: string;
  summary: {
    totalMilestones: number;
    certifiedMilestones: number;
    eligiblePayments: number;
    settledPayments: number;
  };
  kpis: KpiResult[];
  alerts: DashboardAlert[];
  generatedAt: string;
};

export type IntelligenceCheckpoint = {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  createdAt: string;
};

export type RebuildJob = {
  id: string;
  tenantId: string;
  workspaceId: string;
  target: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  createdAt: string;
};

export type ProjectionCheckpoint = {
  id: string; tenantId: string; workspaceId: string; projectionName: string;
  projectionType: string; consumerName: string; lastEventId?: string;
  lastEventSequence: number; lastProcessedAt?: string;
  status: 'RUNNING' | 'DONE' | 'FAILED'; failureReason?: string;
  createdAt: string; updatedAt: string;
};

export type ProjectionRecord = {
  id: string; tenantId: string; workspaceId: string; projectionType: string;
  sourceEventId: string; sourceEventSequence: number; aggregateId: string;
  eventType: string; createdAt: string;
};

export type ExecutionForecast = {
  id: string; tenantId: string; workspaceId: string; contractId?: string;
  milestoneId?: string; executionWorkspaceId?: string; forecastType: string;
  scopeType?: string; scopeId?: string; modelId: string; modelVersion: string;
  featureSnapshot: Readonly<Record<string, unknown>>; predictedValue: unknown;
  confidenceScore: number; confidenceInterval?: { lower: number; upper: number };
  riskLevel?: string; explanation: string; recommendedActions: string[];
  status: 'CURRENT' | 'STALE' | 'EXPIRED' | 'SUPERSEDED' | 'INVALIDATED';
  generatedAt: string; expiresAt: string; reviewStatus: string; createdAt: string;
};

export type ForecastOutcome = {
  id: string; tenantId: string; workspaceId: string; forecastId: string;
  actualOutcome: unknown; recordedBy: string; recordedAt: string;
};

export type AlertInstance = {
  id: string; tenantId: string; workspaceId: string; alertKey: string;
  severity: string; title: string; detail: string; assignment: string;
  dedupeKey: string; status: 'OPEN' | 'CLOSED'; createdAt: string;
};

export type ReportDefinition = {
  id: string; tenantId: string; workspaceId: string; reportKey: string; name: string;
  reportType: string; scopeType: string; queryConfiguration: Record<string, unknown>;
  fieldConfiguration: { allowedFields: string[]; maskedFields: string[] };
  scheduleConfiguration: Record<string, unknown>; deliveryConfiguration: Record<string, unknown>;
  classification: string; allowedRoles: string[]; exportPolicy: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; version: number; createdAt: string; updatedAt: string;
};

export type ReportRun = {
  id: string; tenantId: string; workspaceId: string; reportDefinitionId: string;
  requestedBy: string; periodStart?: string; periodEnd?: string;
  parameters: Record<string, unknown>; status: 'COMPLETED' | 'FAILED' | 'EXPIRED';
  outputStorageReference: string; outputHash: string; recordCount: number;
  maskedFields: string[]; exportPolicy: string; generatedAt: string;
  expiresAt: string; createdAt: string;
};

export type KpiFormulaValidationError = {
  code: string; field: string; message: string; position?: number;
};

export type KpiDefinition = {
  id: string;
  tenantId: string;
  workspaceId: string;
  kpiKey: string;
  name: string;
  domain: string;
  aggregationType: string;
  formulaExpression: string;
  unit: string;
  direction: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt?: string;
  publishedBy?: string;
  createdAt: string;
};

export type KpiDefinitionResult = {
  id: string;
  kpiDefinitionId: string;
  tenantId: string;
  workspaceId: string;
  scopeType: string;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  resultValue: number | null;
  calculationStatus?: 'CALCULATED' | 'NOT_CALCULABLE';
  resultUnit: string;
  kpiDefinitionVersion: number;
  createdAt: string;
};

export type KpiProfile = {
  id: string;
  tenantId: string;
  workspaceId: string;
  role: string;
  metricKeys: string[];
  createdAt: string;
};

export type DashboardMetric = {
  key: string;
  value: number | string;
  masked: boolean;
};

export type DashboardSnapshot = {
  id: string;
  tenantId: string;
  workspaceId: string;
  scopeType: string;
  scopeId: string;
  dashboardName: string;
  metrics: DashboardMetric[];
  createdAt: string;
};

export type GovernedAiPolicy = {
  allowOperationalDecisionMaking: boolean;
  requireHumanReview: boolean;
  approvedBy: string;
};

export type GovernedAiReview = {
  id: string;
  tenantId: string;
  workspaceId: string;
  subject: string;
  requestedBy: string;
  summary: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  policy: GovernedAiPolicy;
  createdAt: string;
};

export type SettlementCase = {
  id: string;
  tenantId: string;
  workspaceId: string;
  organizationId?: string;
  contractId: string;
  milestoneId: string;
  paymentEligibilityId: string;
  status: 'ELIGIBILITY_CONFIRMED' | 'ENTITLEMENT_CALCULATED' | 'FUNDED' | 'APPROVED_FOR_RELEASE' | 'SETTLED' | 'CANCELLED';
  currency: 'NGN';
  grossEligibleAmountMinor: number;
  netPayableAmountMinor: number;
  releasedAmountMinor: number;
  settledAmountMinor: number;
  reconciledAmountMinor: number;
  disputedAmountMinor: number;
  retainedAmountMinor: number;
  outstandingAmountMinor: number;
  createdAt: string;
};

export type FinancialEntitlement = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  paymentEligibilityId: string;
  currency: 'NGN';
  grossAmountMinor: number;
  variationAmountMinor: number;
  incentiveAmountMinor: number;
  reimbursementAmountMinor: number;
  retentionAmountMinor: number;
  penaltyAmountMinor: number;
  serviceCreditAmountMinor: number;
  advanceRecoveryAmountMinor: number;
  taxWithholdingAmountMinor: number;
  otherDeductionAmountMinor: number;
  netPayableAmountMinor: number;
  status: 'APPROVED' | 'CALCULATED';
  calculatedAt: string;
  createdAt: string;
};

export type Invoice = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  invoiceNumber: string;
  grossAmountMinor: number;
  taxAmountMinor: number;
  deductionAmountMinor: number;
  netAmountMinor: number;
  documentHash: string;
  supplierPartyId: string;
  status: 'VALID' | 'DRAFT' | 'REJECTED';
  createdAt: string;
};

export type FundingCommitment = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  committedAmountMinor: number;
  fundedAmountMinor: number;
  reservedAmountMinor: number;
  currency: 'NGN';
  providerId: string;
  status: 'FUNDED' | 'INSUFFICIENT_FUNDS' | 'PENDING';
  externalCommitmentReference: string;
  confirmedAt?: string;
  createdAt: string;
};

export type ReleaseRequest = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  requestedAmountMinor: number;
  currency: 'NGN';
  beneficiaryAccountReferenceId: string;
  status: 'APPROVED' | 'BLOCKED' | 'DRAFT';
  createdAt: string;
};

export type PaymentInstruction = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  releaseRequestId: string;
  providerId: string;
  amountMinor: number;
  currency: 'NGN';
  idempotencyKey: string;
  status: 'CREATED' | 'SUBMITTED' | 'SETTLED' | 'FAILED';
  providerReference: string;
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  tenantId: string;
  workspaceId: string;
  settlementCaseId: string;
  amountMinor: number;
  currency: 'NGN';
  entryType: 'PAYMENT_SETTLED';
  referenceId: string;
  createdAt: string;
};
export * from './trust';

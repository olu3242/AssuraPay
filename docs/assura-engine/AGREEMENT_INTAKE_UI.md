# Agreement Intake Product Surface

Start Agreement shows three choices only:

1. Create from scratch — describe the transaction.
2. Use what you already have — quote/invoice/proposal/PO/email/message source.
3. Upload a contract — existing formal agreement/SOW.

All paths converge on one Review Agreement surface. Display title, parties, scope, amount/currency, payment terms, source provenance where applicable, confidence as supporting information, and unresolved clarity items. Primary action is `Review & continue`; conversion is disabled while required clarification remains.

Never present AI output as accepted fact. Label extracted terms as proposed until reviewed. Never expose internal engine names, prompts or governance implementation details in customer copy. Never hardcode agreement lifecycle state in the browser.

Browser E2E scenarios: direct description with missing terms -> clarify -> ready -> convert; informal artifact with provenance -> review -> convert; formal contract -> extraction/provenance -> review -> convert; negative cross-workspace access; duplicate convert returns same agreement; failed canonical create leaves intake unconverted.

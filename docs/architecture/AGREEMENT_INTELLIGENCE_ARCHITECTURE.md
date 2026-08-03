# Agreement Intelligence Architecture

`@assurapay/agreement-intelligence` consumes an executed Batch 3 document and certificate without replacing either. The authority order is executed version → signed document → human-validated structured intelligence → advisory extraction proposal.

Analysis can call models only through `GovernedAnalysisGateway`; model and prompt versions, hashes, confidence and source references are retained. Risk is deterministic and versioned. Repository search filters classification before returning metadata and never returns storage references. Published intelligence requires completed human review and becomes immutable; corrections create a new version.

The deterministic gateway and in-memory secure-store adapter certify orchestration only. Production model governance, OCR/vector infrastructure, object storage, malware scanning and live PostgreSQL RLS remain deployment gates.

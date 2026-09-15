# Agreement Intake Release / Evolution Contract

The three intake paths are a front-door extension of the existing Agreement domain, not a replacement. Downstream milestones, Definition of Done, evidence, validation, risk, approvals, payment orchestration and audit remain authoritative.

Operational metrics to add to persona reporting after production persistence is wired: intake_started; intake_ready; clarification_required; clarification_resolved; intake_converted; conversion_failed; time_to_ready; time_to_agreement; source_type distribution. Metrics must not contain raw contract/message content.

Evolution loop: use aggregate, privacy-safe failure reasons to improve clarification prompts and extraction profiles. Model/prompt changes remain versioned and governed; historical source/provenance and accepted agreement versions remain immutable.

Rollback rule: disabling three-path intake must not alter existing canonical agreements. Existing converted agreements continue through the current lifecycle. Unconverted intake records remain non-executable and cannot trigger payment.

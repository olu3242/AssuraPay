# ADR — Three ways in, one Agreement

Decision: keep the existing Agreement aggregate and lifecycle authoritative. Three intake source types are adapters/provenance, not domain variants.

Consequences: downstream services do not branch on how an agreement began; source uncertainty is resolved before conversion; accepted/executed agreement semantics stay unchanged; future source types can be added without creating payment/governance bypasses.

Rejected: separate AI agreement model; separate informal-contract lifecycle; direct document-to-payment automation; treating extraction confidence as party acceptance.

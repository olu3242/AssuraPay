# Party Verification Architecture

Parties are workspace-scoped. Verification providers implement a neutral interface; CI uses only the deterministic sandbox adapter. Provider results are append-only and manual review creates a superseding result. Beneficiary references are tokenized, serialized views omit tokens, and display identifiers expose only the last four characters.

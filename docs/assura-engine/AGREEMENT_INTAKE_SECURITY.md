# Agreement Intake Security Boundary

The intake layer is non-executable. It may collect, extract, normalize and propose commercial terms. It must never become a shortcut around canonical agreement governance.

Protected actions remain downstream: party acceptance/signature; agreement approval/activation; completion certification; release authorization; payment execution.

Source handling: retain secure artifact references plus hashes/provenance; avoid raw message/document bodies in intake persistence; malware/content controls apply before document processing; authorization is checked on every source retrieval. AI-generated or extracted terms retain confidence/provenance and remain proposed until human/governed review.

Failure semantics: extraction failure leaves no accepted agreement state; canonical creation failure leaves intake unconverted; payment infrastructure is unreachable from intake routes/services; rollback cannot mutate already-created canonical agreements.

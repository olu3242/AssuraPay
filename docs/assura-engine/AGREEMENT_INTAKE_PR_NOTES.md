# PR notes

This branch deliberately preserves the existing Agreement aggregate and protected lifecycle. Review migration conventions and RLS session settings carefully before merge. The next code review should reject any implementation that lets an intake route call activation/payment directly, persists raw sensitive source content, trusts client authority fields, or marks conversion before canonical creation succeeds.

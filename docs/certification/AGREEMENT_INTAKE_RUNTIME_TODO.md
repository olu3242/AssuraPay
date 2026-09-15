# Runtime TODO

The GitHub connector can mutate repository content but does not execute pnpm, PostgreSQL or Playwright. Therefore the following are deliberately not asserted green: compile/typecheck of new files; migration execution; live RLS; authenticated route behavior; browser UX; accessibility; full regression. Execute these in CI/Work/local runtime and attach evidence to PR #49 before merge.

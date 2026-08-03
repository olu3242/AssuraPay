# Authorization Architecture

Authorization is deny-by-default. Applicable explicit denial overrides allowance. Evaluation returns source grants and denial reasons. Field rules execute before serialization. Delegations are scoped and expiring and can contain only permissions the delegator currently holds. Authority uses integer minor units; segregation rules can block conflicting permissions.

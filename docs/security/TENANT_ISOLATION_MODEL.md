# Tenant Isolation Model

Application services require explicit active-workspace membership. Repository lookups include workspace scope. PostgreSQL tenant tables enable RLS and use active membership policies derived from trusted transaction settings. The migration contract is tested statically; live PostgreSQL policy execution remains required for full certification.

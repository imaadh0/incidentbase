SET ROLE incidentbase_schema_owner;

-- PostgreSQL may evaluate every permissive policy expression. API transactions
-- can execute this predicate, but it returns false unless SET ROLE selected the
-- dedicated worker group role.
GRANT EXECUTE ON FUNCTION app.is_worker_context() TO incidentbase_runtime;

RESET ROLE;

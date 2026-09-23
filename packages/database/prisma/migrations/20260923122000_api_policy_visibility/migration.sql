SET ROLE incidentbase_schema_owner;

-- Worker transactions may evaluate API membership policy expressions while
-- combining permissive policies. The function returns false without a user
-- context, so execution is safe and grants no membership access.
GRANT EXECUTE ON FUNCTION app.has_active_membership(UUID) TO incidentbase_worker;

RESET ROLE;

CREATE FUNCTION app.auth_current_identity(target_user_id UUID)
RETURNS TABLE (id UUID, email TEXT, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'user lookup does not match current user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT candidate.id, candidate.email, candidate.display_name
    FROM public.users AS candidate
    WHERE candidate.id = target_user_id;
END
$$;

REVOKE ALL ON FUNCTION app.auth_current_identity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_current_identity(UUID) TO incidentbase_runtime;

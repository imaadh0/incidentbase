CREATE FUNCTION app.auth_mark_email_verified(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.users SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE id = target_user_id AND email_verified_at IS NULL;
END
$$;

REVOKE ALL ON FUNCTION app.auth_mark_email_verified(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_mark_email_verified(UUID) TO incidentbase_runtime;

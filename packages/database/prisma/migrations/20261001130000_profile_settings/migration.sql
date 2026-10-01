ALTER TABLE public.users
  ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'blue',
  ADD CONSTRAINT users_avatar_color_check
    CHECK (avatar_color IN ('blue', 'teal', 'violet', 'coral', 'amber', 'slate'));

DROP FUNCTION app.auth_current_identity(UUID);

CREATE FUNCTION app.auth_current_identity(target_user_id UUID)
RETURNS TABLE (id UUID, email TEXT, display_name TEXT, avatar_color TEXT)
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
    SELECT candidate.id, candidate.email, candidate.display_name, candidate.avatar_color
    FROM public.users AS candidate
    WHERE candidate.id = target_user_id;
END
$$;

REVOKE ALL ON FUNCTION app.auth_current_identity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_current_identity(UUID) TO incidentbase_runtime;

CREATE FUNCTION app.auth_update_profile(
  target_user_id UUID,
  new_display_name TEXT,
  new_avatar_color TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'profile update does not match current user' USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
  SET display_name = new_display_name,
      avatar_color = new_avatar_color,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = target_user_id;
END
$$;

REVOKE ALL ON FUNCTION app.auth_update_profile(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_update_profile(UUID, TEXT, TEXT) TO incidentbase_runtime;

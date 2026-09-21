ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ(3),
  ADD CONSTRAINT users_email_normalized_check
    CHECK (email = lower(btrim(email)));

ALTER TABLE refresh_sessions
  ADD COLUMN family_id UUID,
  ADD COLUMN replaced_by_id UUID,
  ADD COLUMN revoked_reason TEXT,
  ADD COLUMN last_used_at TIMESTAMPTZ(3);

UPDATE refresh_sessions SET family_id = id WHERE family_id IS NULL;
ALTER TABLE refresh_sessions ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE refresh_sessions ALTER COLUMN family_id SET DEFAULT gen_random_uuid();
CREATE INDEX refresh_sessions_user_id_family_id_idx
  ON refresh_sessions(user_id, family_id);

CREATE FUNCTION app.auth_login_identity(target_email TEXT)
RETURNS TABLE (
  id UUID,
  email TEXT,
  display_name TEXT,
  password_hash TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT candidate.id, candidate.email, candidate.display_name, candidate.password_hash
  FROM public.users AS candidate
  WHERE candidate.email = lower(btrim(target_email))
  LIMIT 1
$$;

CREATE FUNCTION app.auth_register_owner(
  new_user_id UUID,
  normalized_email TEXT,
  new_display_name TEXT,
  new_password_hash TEXT,
  new_organization_id UUID,
  new_organization_slug TEXT,
  new_organization_name TEXT,
  new_membership_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF normalized_email <> lower(btrim(normalized_email)) THEN
    RAISE EXCEPTION 'email must be normalized' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (id, email, display_name, password_hash, updated_at)
  VALUES (new_user_id, normalized_email, new_display_name, new_password_hash, CURRENT_TIMESTAMP);

  INSERT INTO public.organizations (id, slug, name, updated_at)
  VALUES (new_organization_id, new_organization_slug, new_organization_name, CURRENT_TIMESTAMP);

  INSERT INTO public.organization_memberships
    (id, organization_id, user_id, role, status, updated_at)
  VALUES
    (new_membership_id, new_organization_id, new_user_id, 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP);
END
$$;

CREATE FUNCTION app.auth_list_memberships(target_user_id UUID)
RETURNS TABLE (
  membership_id UUID,
  organization_id UUID,
  organization_slug TEXT,
  organization_name TEXT,
  role organization_role,
  status membership_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'membership lookup does not match current user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT membership.id, organization.id, organization.slug, organization.name,
           membership.role, membership.status
    FROM public.organization_memberships AS membership
    JOIN public.organizations AS organization ON organization.id = membership.organization_id
    WHERE membership.user_id = target_user_id
    ORDER BY membership.created_at, membership.id;
END
$$;

CREATE FUNCTION app.auth_create_refresh_session(
  target_user_id UUID,
  target_organization_id UUID,
  new_session_id UUID,
  new_family_id UUID,
  new_token_hash TEXT,
  new_expires_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.organization_memberships
       WHERE organization_id = target_organization_id
         AND user_id = target_user_id
         AND status = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'active membership required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.refresh_sessions
    (id, organization_id, user_id, token_hash, family_id, expires_at)
  VALUES
    (new_session_id, target_organization_id, target_user_id, new_token_hash,
     new_family_id, new_expires_at);
END
$$;

CREATE FUNCTION app.auth_rotate_refresh_session(
  current_token_hash TEXT,
  new_session_id UUID,
  new_token_hash TEXT,
  new_expires_at TIMESTAMPTZ
)
RETURNS TABLE (
  outcome TEXT,
  user_id UUID,
  organization_id UUID,
  family_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_session public.refresh_sessions%ROWTYPE;
BEGIN
  SELECT * INTO current_session
  FROM public.refresh_sessions
  WHERE token_hash = current_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF current_session.revoked_at IS NOT NULL THEN
    UPDATE public.refresh_sessions
    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
        revoked_reason = 'REUSE_DETECTED'
    WHERE refresh_sessions.user_id = current_session.user_id
      AND refresh_sessions.family_id = current_session.family_id;
    RETURN QUERY SELECT 'REUSED'::TEXT, current_session.user_id,
                        current_session.organization_id, current_session.family_id;
    RETURN;
  END IF;

  IF current_session.expires_at <= CURRENT_TIMESTAMP THEN
    UPDATE public.refresh_sessions
    SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'EXPIRED'
    WHERE refresh_sessions.organization_id = current_session.organization_id
      AND refresh_sessions.id = current_session.id;
    RETURN QUERY SELECT 'EXPIRED'::TEXT, current_session.user_id,
                        current_session.organization_id, current_session.family_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_memberships.organization_id = current_session.organization_id
      AND organization_memberships.user_id = current_session.user_id
      AND status = 'ACTIVE'
  ) THEN
    UPDATE public.refresh_sessions
    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
        revoked_reason = 'MEMBERSHIP_INACTIVE'
    WHERE refresh_sessions.user_id = current_session.user_id
      AND refresh_sessions.family_id = current_session.family_id;
    RETURN QUERY SELECT 'MEMBERSHIP_INACTIVE'::TEXT, current_session.user_id,
                        current_session.organization_id, current_session.family_id;
    RETURN;
  END IF;

  UPDATE public.refresh_sessions
  SET revoked_at = CURRENT_TIMESTAMP,
      revoked_reason = 'ROTATED',
      replaced_by_id = new_session_id,
      last_used_at = CURRENT_TIMESTAMP
  WHERE refresh_sessions.organization_id = current_session.organization_id
    AND refresh_sessions.id = current_session.id;

  INSERT INTO public.refresh_sessions
    (id, organization_id, user_id, token_hash, family_id, expires_at)
  VALUES
    (new_session_id, current_session.organization_id, current_session.user_id,
     new_token_hash, current_session.family_id, new_expires_at);

  RETURN QUERY SELECT 'ROTATED'::TEXT, current_session.user_id,
                      current_session.organization_id, current_session.family_id;
END
$$;

CREATE FUNCTION app.auth_revoke_refresh_session(current_token_hash TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.refresh_sessions
  SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
      revoked_reason = COALESCE(revoked_reason, 'LOGOUT')
  WHERE token_hash = current_token_hash
$$;

CREATE FUNCTION app.auth_revoke_all_sessions(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'session owner mismatch' USING ERRCODE = '42501';
  END IF;

  UPDATE public.refresh_sessions
  SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
      revoked_reason = COALESCE(revoked_reason, 'LOGOUT_ALL')
  WHERE user_id = target_user_id;
END
$$;

CREATE FUNCTION app.auth_accept_invitation(
  current_token_hash TEXT,
  target_user_id UUID,
  new_membership_id UUID
)
RETURNS TABLE (outcome TEXT, organization_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  invitation public.organization_invitations%ROWTYPE;
  user_email TEXT;
BEGIN
  IF target_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'invitation user mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO invitation
  FROM public.organization_invitations
  WHERE token_hash = current_token_hash
  FOR UPDATE;

  IF NOT FOUND OR invitation.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF invitation.expires_at <= CURRENT_TIMESTAMP THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, invitation.organization_id;
    RETURN;
  END IF;

  SELECT email INTO user_email FROM public.users WHERE id = target_user_id;
  IF user_email IS DISTINCT FROM invitation.email THEN
    RETURN QUERY SELECT 'EMAIL_MISMATCH'::TEXT, invitation.organization_id;
    RETURN;
  END IF;

  INSERT INTO public.organization_memberships
    (id, organization_id, user_id, role, status, updated_at)
  VALUES
    (new_membership_id, invitation.organization_id, target_user_id,
     invitation.role, 'ACTIVE', CURRENT_TIMESTAMP)
  ON CONFLICT (organization_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP;

  UPDATE public.organization_invitations
  SET accepted_at = CURRENT_TIMESTAMP
  WHERE organization_invitations.organization_id = invitation.organization_id
    AND organization_invitations.id = invitation.id;

  RETURN QUERY SELECT 'ACCEPTED'::TEXT, invitation.organization_id;
END
$$;

REVOKE ALL ON FUNCTION app.auth_login_identity(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_register_owner(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_list_memberships(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_create_refresh_session(UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_rotate_refresh_session(TEXT, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_revoke_refresh_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_revoke_all_sessions(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_accept_invitation(TEXT, UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.auth_login_identity(TEXT) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_register_owner(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, UUID) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_list_memberships(UUID) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_create_refresh_session(UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_rotate_refresh_session(TEXT, UUID, TEXT, TIMESTAMPTZ) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_revoke_refresh_session(TEXT) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_revoke_all_sessions(UUID) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_accept_invitation(TEXT, UUID, UUID) TO incidentbase_runtime;

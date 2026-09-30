CREATE FUNCTION app.auth_preview_invitation(current_token_hash TEXT)
RETURNS TABLE (outcome TEXT, organization_id UUID, organization_name TEXT, email TEXT, role public.organization_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN invitation.accepted_at IS NOT NULL THEN 'USED'
           WHEN invitation.expires_at <= CURRENT_TIMESTAMP THEN 'EXPIRED'
           ELSE 'AVAILABLE'
         END,
         organization.id, organization.name, invitation.email, invitation.role
  FROM public.organization_invitations AS invitation
  JOIN public.organizations AS organization ON organization.id = invitation.organization_id
  WHERE invitation.token_hash = current_token_hash
  LIMIT 1
$$;

CREATE FUNCTION app.auth_register_invitee(
  current_token_hash TEXT,
  normalized_email TEXT,
  new_display_name TEXT,
  new_password_hash TEXT,
  new_user_id UUID,
  new_membership_id UUID
)
RETURNS TABLE (outcome TEXT, organization_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  invitation public.organization_invitations%ROWTYPE;
BEGIN
  SELECT candidate.* INTO invitation
  FROM public.organization_invitations AS candidate
  WHERE candidate.token_hash = current_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF invitation.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'USED'::TEXT, invitation.organization_id;
    RETURN;
  END IF;
  IF invitation.expires_at <= CURRENT_TIMESTAMP THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, invitation.organization_id;
    RETURN;
  END IF;
  IF normalized_email IS DISTINCT FROM invitation.email THEN
    RETURN QUERY SELECT 'EMAIL_MISMATCH'::TEXT, invitation.organization_id;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE users.email = normalized_email) THEN
    RETURN QUERY SELECT 'EMAIL_EXISTS'::TEXT, invitation.organization_id;
    RETURN;
  END IF;

  INSERT INTO public.users (id, email, display_name, password_hash, updated_at)
  VALUES (new_user_id, normalized_email, new_display_name, new_password_hash, CURRENT_TIMESTAMP);
  INSERT INTO public.organization_memberships
    (id, organization_id, user_id, role, status, updated_at)
  VALUES
    (new_membership_id, invitation.organization_id, new_user_id,
     invitation.role, 'ACTIVE', CURRENT_TIMESTAMP);
  UPDATE public.organization_invitations AS accepted_invitation
  SET accepted_at = CURRENT_TIMESTAMP
  WHERE accepted_invitation.organization_id = invitation.organization_id
    AND accepted_invitation.id = invitation.id;

  RETURN QUERY SELECT 'ACCEPTED'::TEXT, invitation.organization_id;
END
$$;

REVOKE ALL ON FUNCTION app.auth_preview_invitation(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_register_invitee(TEXT, TEXT, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_preview_invitation(TEXT) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_register_invitee(TEXT, TEXT, TEXT, TEXT, UUID, UUID) TO incidentbase_runtime;

CREATE OR REPLACE FUNCTION app.auth_accept_invitation(
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

  SELECT candidate.* INTO invitation
  FROM public.organization_invitations AS candidate
  WHERE candidate.token_hash = current_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF invitation.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'USED'::TEXT, invitation.organization_id;
    RETURN;
  END IF;
  IF invitation.expires_at <= CURRENT_TIMESTAMP THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, invitation.organization_id;
    RETURN;
  END IF;

  SELECT candidate.email INTO user_email
  FROM public.users AS candidate WHERE candidate.id = target_user_id;
  IF user_email IS DISTINCT FROM invitation.email THEN
    RETURN QUERY SELECT 'EMAIL_MISMATCH'::TEXT, invitation.organization_id;
    RETURN;
  END IF;

  INSERT INTO public.organization_memberships
    (id, organization_id, user_id, role, status, updated_at)
  VALUES
    (new_membership_id, invitation.organization_id, target_user_id,
     invitation.role, 'ACTIVE', CURRENT_TIMESTAMP)
  ON CONFLICT ON CONSTRAINT organization_memberships_organization_id_user_id_key
  DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP;
  UPDATE public.organization_invitations AS accepted_invitation
  SET accepted_at = CURRENT_TIMESTAMP
  WHERE accepted_invitation.organization_id = invitation.organization_id
    AND accepted_invitation.id = invitation.id;
  RETURN QUERY SELECT 'ACCEPTED'::TEXT, invitation.organization_id;
END
$$;

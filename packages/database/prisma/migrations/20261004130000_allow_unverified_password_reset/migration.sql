CREATE OR REPLACE FUNCTION app.auth_prepare_password_reset(target_email TEXT, new_token_hash TEXT, new_expires_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE target_user_id UUID;
BEGIN
  SELECT id INTO target_user_id FROM public.users
  WHERE email = lower(btrim(target_email))
  FOR UPDATE;
  IF target_user_id IS NULL THEN RETURN FALSE; END IF;
  INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (target_user_id, new_token_hash, new_expires_at)
  ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
    expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP;
  RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION app.auth_consume_password_reset(current_token_hash TEXT, new_password_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE target_user_id UUID;
BEGIN
  SELECT user_id INTO target_user_id FROM public.password_reset_tokens
  WHERE token_hash = current_token_hash AND expires_at > CURRENT_TIMESTAMP
  FOR UPDATE;
  IF target_user_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.users SET password_hash = new_password_hash,
    email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
    auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = target_user_id;
  UPDATE public.refresh_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    revoked_reason = COALESCE(revoked_reason, 'PASSWORD_RESET')
  WHERE user_id = target_user_id;
  DELETE FROM public.password_reset_tokens WHERE user_id = target_user_id;
  RETURN target_user_id;
END $$;

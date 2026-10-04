ALTER TABLE public.users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE public.password_reset_tokens (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX password_reset_tokens_expires_at_idx ON public.password_reset_tokens(expires_at);
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.auth_version(target_user_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT auth_version FROM public.users WHERE id = target_user_id
$$;

CREATE FUNCTION app.auth_prepare_password_reset(target_email TEXT, new_token_hash TEXT, new_expires_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE target_user_id UUID;
BEGIN
  SELECT id INTO target_user_id FROM public.users
  WHERE email = lower(btrim(target_email)) AND email_verified_at IS NOT NULL
  FOR UPDATE;
  IF target_user_id IS NULL THEN RETURN FALSE; END IF;
  INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (target_user_id, new_token_hash, new_expires_at)
  ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
    expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP;
  RETURN TRUE;
END $$;

CREATE FUNCTION app.auth_consume_password_reset(current_token_hash TEXT, new_password_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE target_user_id UUID;
BEGIN
  SELECT user_id INTO target_user_id FROM public.password_reset_tokens
  WHERE token_hash = current_token_hash AND expires_at > CURRENT_TIMESTAMP
  FOR UPDATE;
  IF target_user_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.users SET password_hash = new_password_hash,
    auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = target_user_id;
  UPDATE public.refresh_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    revoked_reason = COALESCE(revoked_reason, 'PASSWORD_RESET')
  WHERE user_id = target_user_id;
  DELETE FROM public.password_reset_tokens WHERE user_id = target_user_id;
  RETURN target_user_id;
END $$;

REVOKE ALL ON FUNCTION app.auth_version(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_prepare_password_reset(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_consume_password_reset(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_version(UUID) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_prepare_password_reset(TEXT, TEXT, TIMESTAMPTZ) TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.auth_prepare_password_reset(TEXT, TEXT, TIMESTAMPTZ) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.auth_consume_password_reset(TEXT, TEXT) TO incidentbase_runtime;

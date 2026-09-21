-- Runtime roles are intentionally group roles. Deployment-specific login roles receive
-- membership in incidentbase_runtime outside application migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'incidentbase_schema_owner') THEN
    CREATE ROLE incidentbase_schema_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'incidentbase_runtime') THEN
    CREATE ROLE incidentbase_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE incidentbase_schema_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS;
ALTER ROLE incidentbase_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;

GRANT incidentbase_schema_owner TO CURRENT_USER;
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT, CREATE ON DATABASE %I TO incidentbase_schema_owner',
    current_database()
  );
END
$$;
GRANT USAGE, CREATE ON SCHEMA public TO incidentbase_schema_owner;
SET ROLE incidentbase_schema_owner;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION incidentbase_schema_owner;

CREATE TYPE organization_role AS ENUM ('OWNER', 'ADMIN', 'RESPONDER', 'REPORTER');
CREATE TYPE membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

CREATE TABLE users (
  id UUID NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE organizations (
  id UUID NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT organizations_pkey PRIMARY KEY (id),
  CONSTRAINT organizations_slug_key UNIQUE (slug)
);

CREATE TABLE organization_memberships (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role organization_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'INVITED',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT organization_memberships_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT organization_memberships_organization_id_user_id_key
    UNIQUE (organization_id, user_id),
  CONSTRAINT organization_memberships_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT organization_memberships_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE organization_invitations (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  email TEXT NOT NULL,
  role organization_role NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by_user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  accepted_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_invitations_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT organization_invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT organization_invitations_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT organization_invitations_invited_by_user_id_fkey
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT organization_invitations_organization_id_invited_by_user_i_fkey
    FOREIGN KEY (organization_id, invited_by_user_id)
    REFERENCES organization_memberships(organization_id, user_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE refresh_sessions (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  revoked_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT refresh_sessions_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT refresh_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_sessions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT refresh_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT refresh_sessions_organization_id_user_id_fkey
    FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships(organization_id, user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX organization_memberships_user_id_idx
  ON organization_memberships(user_id);
CREATE INDEX organization_invitations_organization_id_email_idx
  ON organization_invitations(organization_id, email);
CREATE INDEX refresh_sessions_user_id_idx ON refresh_sessions(user_id);

CREATE FUNCTION app.current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID
$$;

CREATE FUNCTION app.current_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::UUID
$$;

CREATE FUNCTION app.has_active_membership(target_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = app.current_user_id()
      AND membership.status = 'ACTIVE'
  )
$$;

REVOKE ALL ON FUNCTION app.has_active_membership(UUID) FROM PUBLIC;

CREATE FUNCTION app.prevent_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$$;

CREATE FUNCTION app.enforce_active_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_organization_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    target_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_organization_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.organization_id
      ELSE NEW.organization_id
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = target_organization_id)
     AND NOT EXISTS (
       SELECT 1
       FROM public.organization_memberships
       WHERE organization_id = target_organization_id
         AND role = 'OWNER'
         AND status = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'organization % must retain at least one active owner',
      target_organization_id
      USING ERRCODE = '23514', CONSTRAINT = 'organizations_active_owner_check';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER organizations_active_owner
AFTER INSERT ON organizations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_owner();

CREATE CONSTRAINT TRIGGER memberships_active_owner
AFTER INSERT OR UPDATE OR DELETE ON organization_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_owner();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY users_self_access ON users
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());

CREATE POLICY organizations_tenant_access ON organizations
  USING (
    id = app.current_organization_id()
    AND app.has_active_membership(id)
  )
  WITH CHECK (
    id = app.current_organization_id()
    AND app.has_active_membership(id)
  );

CREATE POLICY memberships_tenant_access ON organization_memberships
  USING (
    organization_id = app.current_organization_id()
    AND app.has_active_membership(organization_id)
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND app.has_active_membership(organization_id)
  );

CREATE POLICY invitations_tenant_access ON organization_invitations
  USING (
    organization_id = app.current_organization_id()
    AND app.has_active_membership(organization_id)
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND app.has_active_membership(organization_id)
  );

CREATE POLICY refresh_sessions_tenant_access ON refresh_sessions
  USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.has_active_membership(organization_id)
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.has_active_membership(organization_id)
  );

GRANT USAGE ON SCHEMA public, app TO incidentbase_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON users, organizations, organization_memberships,
     organization_invitations, refresh_sessions
  TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.current_organization_id() TO incidentbase_runtime;
GRANT EXECUTE ON FUNCTION app.has_active_membership(UUID) TO incidentbase_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE incidentbase_schema_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO incidentbase_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE incidentbase_schema_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO incidentbase_runtime;

RESET ROLE;

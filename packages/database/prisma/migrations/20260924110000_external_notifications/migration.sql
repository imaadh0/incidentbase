SET ROLE incidentbase_schema_owner;

CREATE TYPE notification_channel AS ENUM ('EMAIL', 'SLACK', 'DISCORD');
CREATE TYPE notification_delivery_status AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE notification_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  slack_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  discord_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  slack_webhook_ciphertext TEXT,
  discord_webhook_ciphertext TEXT,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT slack_enabled_requires_secret CHECK (NOT slack_enabled OR slack_webhook_ciphertext IS NOT NULL),
  CONSTRAINT discord_enabled_requires_secret CHECK (NOT discord_enabled OR discord_webhook_ciphertext IS NOT NULL)
);

CREATE TABLE notification_deliveries (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  channel notification_channel NOT NULL,
  recipient TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status notification_delivery_status NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ(3),
  provider_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT notification_delivery_event_fk FOREIGN KEY (organization_id, event_id)
    REFERENCES outbox_events(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_delivery_key_unique UNIQUE (organization_id, delivery_key)
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries(status, available_at);
CREATE INDEX notification_deliveries_tenant_idx ON notification_deliveries(organization_id, created_at DESC);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_settings_tenant_access ON notification_settings
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY notification_deliveries_tenant_access ON notification_deliveries
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY notification_settings_worker_access ON notification_settings
  USING (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY notification_deliveries_worker_access ON notification_deliveries
  USING (organization_id = app.current_organization_id() AND app.is_worker_context())
  WITH CHECK (organization_id = app.current_organization_id() AND app.is_worker_context());

GRANT SELECT, INSERT, UPDATE ON notification_settings TO incidentbase_runtime;
GRANT SELECT ON notification_deliveries TO incidentbase_runtime;
GRANT SELECT ON notification_settings TO incidentbase_worker;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO incidentbase_worker;

CREATE FUNCTION app.worker_notification_recipients(requested_organization_id UUID, requested_membership_id UUID)
RETURNS TABLE (membership_id UUID, email TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user <> 'incidentbase_schema_owner'
     OR NOT pg_has_role(session_user, 'incidentbase_worker', 'member')
     OR requested_organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'worker context required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT membership.id, identity.email
    FROM public.organization_memberships AS membership
    JOIN public.users AS identity ON identity.id = membership.user_id
    WHERE membership.organization_id = requested_organization_id
      AND membership.status = 'ACTIVE'
      AND (requested_membership_id IS NULL AND membership.role IN ('OWNER', 'ADMIN')
           OR membership.id = requested_membership_id)
    ORDER BY membership.id;
END
$$;
REVOKE ALL ON FUNCTION app.worker_notification_recipients(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_notification_recipients(UUID, UUID) TO incidentbase_worker;

CREATE FUNCTION app.worker_claim_notification_deliveries(result_limit INTEGER)
RETURNS TABLE (organization_id UUID, delivery_id UUID, event_id UUID, channel notification_channel,
  recipient TEXT, delivery_key TEXT, subject TEXT, body TEXT, attempts INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  IF result_limit < 1 OR result_limit > 500 THEN
    RAISE EXCEPTION 'invalid delivery batch size' USING ERRCODE = '22023';
  END IF;
  -- A worker may die after the final claim. Expire that lease to a terminal
  -- state rather than leaving a PROCESSING row that can never be reclaimed.
  UPDATE public.notification_deliveries AS expired
  SET status = 'FAILED', last_error = 'Delivery lease expired after maximum attempts.',
      updated_at = clock_timestamp()
  WHERE expired.status = 'PROCESSING' AND expired.attempts >= 8
    AND expired.available_at <= clock_timestamp();
  RETURN QUERY
    WITH claimed AS (
      SELECT d.organization_id, d.id FROM public.notification_deliveries AS d
      WHERE d.status IN ('PENDING', 'PROCESSING') AND d.available_at <= clock_timestamp()
        AND d.attempts < 8
      ORDER BY d.available_at, d.created_at, d.id
      FOR UPDATE SKIP LOCKED LIMIT result_limit
    )
    UPDATE public.notification_deliveries AS d
    SET status = 'PROCESSING', attempts = d.attempts + 1,
        available_at = clock_timestamp() + INTERVAL '30 seconds', updated_at = clock_timestamp(), last_error = NULL
    FROM claimed WHERE d.organization_id = claimed.organization_id AND d.id = claimed.id
    RETURNING d.organization_id, d.id, d.event_id, d.channel, d.recipient,
      d.delivery_key, d.subject, d.body, d.attempts;
END
$$;

CREATE FUNCTION app.worker_finish_notification_delivery(
  requested_organization_id UUID, requested_delivery_id UUID, provider_identifier TEXT,
  failure_message TEXT, retryable BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.notification_deliveries AS d
  SET status = CASE WHEN failure_message IS NULL THEN 'SENT'::public.notification_delivery_status
                    WHEN retryable AND d.attempts < 8 THEN 'PENDING'::public.notification_delivery_status
                    ELSE 'FAILED'::public.notification_delivery_status END,
      sent_at = CASE WHEN failure_message IS NULL THEN clock_timestamp() ELSE NULL END,
      provider_id = left(provider_identifier, 255),
      last_error = left(failure_message, 500),
      available_at = CASE WHEN failure_message IS NOT NULL AND retryable AND d.attempts < 8
        THEN clock_timestamp() + make_interval(secs => LEAST(900, CAST(power(2, d.attempts) AS INTEGER)))
        ELSE d.available_at END,
      updated_at = clock_timestamp()
  WHERE d.organization_id = requested_organization_id AND d.id = requested_delivery_id
    AND d.status = 'PROCESSING';
END
$$;
REVOKE ALL ON FUNCTION app.worker_claim_notification_deliveries(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_finish_notification_delivery(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_claim_notification_deliveries(INTEGER) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.worker_finish_notification_delivery(UUID, UUID, TEXT, TEXT, BOOLEAN) TO incidentbase_worker;

RESET ROLE;

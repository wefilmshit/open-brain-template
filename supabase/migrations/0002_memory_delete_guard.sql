CREATE TABLE IF NOT EXISTS public.memory_delete_audit (
  id bigserial PRIMARY KEY,
  memory_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by text NOT NULL DEFAULT current_user,
  row_data jsonb NOT NULL
);

ALTER TABLE public.memory_delete_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.memory_delete_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.memory_delete_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_memory_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.memory_delete_audit (memory_id, row_data)
  VALUES (OLD.id, to_jsonb(OLD));
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_memory_mass_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
  delete_limit integer := coalesce(
    nullif(current_setting('app.memory_mass_delete_limit', true), '')::int,
    25
  );
BEGIN
  IF current_setting('app.allow_mass_delete', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO deleted_count FROM deleted_rows;
  IF deleted_count > delete_limit THEN
    RAISE EXCEPTION 'MASS_DELETE_BLOCKED: attempted %, limit %', deleted_count, delete_limit;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS memories_delete_audit ON public.memories;
CREATE TRIGGER memories_delete_audit
BEFORE DELETE ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.audit_memory_delete();

DROP TRIGGER IF EXISTS memories_mass_delete_guard ON public.memories;
CREATE TRIGGER memories_mass_delete_guard
AFTER DELETE ON public.memories
REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_memory_mass_delete();

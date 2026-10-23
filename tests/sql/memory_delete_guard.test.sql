DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END
$$;

INSERT INTO public.memories (content, category)
SELECT 'row ' || n, 'fixture' FROM generate_series(1, 40) AS n;

DO $$
DECLARE
  target_id uuid;
BEGIN
  SELECT id INTO target_id FROM public.memories WHERE content = 'row 1';
  DELETE FROM public.memories WHERE id = target_id;
  IF (SELECT count(*) FROM public.memory_delete_audit) <> 1 THEN
    RAISE EXCEPTION 'single delete did not write exactly one audit row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memory_delete_audit WHERE row_data->>'id' = target_id::text
  ) THEN
    RAISE EXCEPTION 'audit row does not contain the deleted memory id';
  END IF;
END
$$;

DO $$
DECLARE
  blocked boolean := false;
BEGIN
  BEGIN
    DELETE FROM public.memories
    WHERE id IN (SELECT id FROM public.memories ORDER BY content LIMIT 26);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%MASS_DELETE_BLOCKED%' THEN blocked := true;
    ELSE RAISE;
    END IF;
  END;
  IF NOT blocked THEN RAISE EXCEPTION '26-row delete was not blocked'; END IF;
  IF (SELECT count(*) FROM public.memories) <> 39 THEN
    RAISE EXCEPTION 'blocked delete changed memories';
  END IF;
  IF (SELECT count(*) FROM public.memory_delete_audit) <> 1 THEN
    RAISE EXCEPTION 'blocked delete left audit residue';
  END IF;
END
$$;

DELETE FROM public.memories
WHERE id IN (SELECT id FROM public.memories ORDER BY content LIMIT 25);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.memories) <> 14 THEN
    RAISE EXCEPTION '25-row delete did not succeed';
  END IF;
  IF (SELECT count(*) FROM public.memory_delete_audit) <> 26 THEN
    RAISE EXCEPTION '25-row delete audit count is wrong';
  END IF;
  IF has_table_privilege('anon', 'public.memory_delete_audit', 'SELECT') THEN
    RAISE EXCEPTION 'anon can select delete audit';
  END IF;
  IF has_table_privilege('authenticated', 'public.memory_delete_audit', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can select delete audit';
  END IF;
END
$$;

BEGIN;
SET LOCAL app.allow_mass_delete = 'on';
DELETE FROM public.memories;
COMMIT;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.memories) <> 0 THEN
    RAISE EXCEPTION 'allowed mass delete did not delete the remainder';
  END IF;
  IF (SELECT count(*) FROM public.memory_delete_audit) <> 40 THEN
    RAISE EXCEPTION 'allowed mass delete audit count is wrong';
  END IF;
END
$$;

from django.db import migrations


GRAPH_TABLES = ("roadnode", "roadsegment", "household", "evacuationdestination")


class Migration(migrations.Migration):
    dependencies = [("api", "0003_evacuation_inputs")]

    operations = [
        migrations.RunSQL(
            sql="""
                CREATE OR REPLACE FUNCTION api_protect_dataset_snapshot() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF (to_jsonb(NEW) - 'sealed_at') IS DISTINCT FROM
                       (to_jsonb(OLD) - 'sealed_at')
                       OR (OLD.sealed_at IS NOT NULL AND
                           NEW.sealed_at IS DISTINCT FROM OLD.sealed_at) THEN
                        RAISE EXCEPTION 'Dataset snapshots are immutable; only initial sealing is allowed.'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END;
                $$;

                CREATE FUNCTION api_protect_dataset_record() RETURNS trigger
                LANGUAGE plpgsql AS $$
                DECLARE
                    dataset_uuid uuid;
                    dataset_sealed_at timestamptz;
                BEGIN
                    IF TG_OP = 'UPDATE' AND NEW.dataset_id IS DISTINCT FROM OLD.dataset_id THEN
                        RAISE EXCEPTION 'Dataset records cannot be moved to another snapshot.'
                            USING ERRCODE = '23514';
                    END IF;
                    IF TG_OP = 'DELETE' THEN
                        dataset_uuid := OLD.dataset_id;
                    ELSE
                        dataset_uuid := NEW.dataset_id;
                    END IF;
                    -- Serialize imports and sealing on the same parent row.
                    SELECT sealed_at INTO dataset_sealed_at FROM api_datasetsnapshot
                        WHERE id = dataset_uuid FOR UPDATE;
                    IF dataset_sealed_at IS NOT NULL THEN
                        RAISE EXCEPTION 'Sealed dataset records cannot be added, changed, or deleted.'
                            USING ERRCODE = '23514';
                    END IF;
                    IF TG_OP = 'DELETE' THEN
                        RETURN OLD;
                    END IF;
                    RETURN NEW;
                END;
                $$;
            """ + "\n".join(
                f"CREATE TRIGGER api_{table}_sealed BEFORE INSERT OR UPDATE OR DELETE "
                f"ON api_{table} FOR EACH ROW EXECUTE FUNCTION api_protect_dataset_record();"
                for table in GRAPH_TABLES
            ),
            reverse_sql="\n".join(
                f"DROP TRIGGER api_{table}_sealed ON api_{table};"
                for table in GRAPH_TABLES
            ) + """
                DROP FUNCTION api_protect_dataset_record();
                CREATE OR REPLACE FUNCTION api_protect_dataset_snapshot() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW IS DISTINCT FROM OLD THEN
                        RAISE EXCEPTION 'Dataset snapshots are immutable; create a new snapshot.'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END;
                $$;
            """,
        ),
    ]

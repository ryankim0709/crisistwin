from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("api", "0001_initial")]

    operations = [
        migrations.RunSQL(
            sql="""
                CREATE FUNCTION api_protect_dataset_snapshot() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW IS DISTINCT FROM OLD THEN
                        RAISE EXCEPTION 'Dataset snapshots are immutable; create a new snapshot.'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER api_dataset_snapshot_immutable
                BEFORE UPDATE ON api_datasetsnapshot
                FOR EACH ROW EXECUTE FUNCTION api_protect_dataset_snapshot();

                CREATE FUNCTION api_protect_run_inputs() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF ROW(NEW.id, NEW.scenario_id, NEW.dataset_id, NEW.schema_version,
                           NEW.input_snapshot, NEW.assumptions_snapshot, NEW.random_seed,
                           NEW.created_at)
                       IS DISTINCT FROM
                       ROW(OLD.id, OLD.scenario_id, OLD.dataset_id, OLD.schema_version,
                           OLD.input_snapshot, OLD.assumptions_snapshot, OLD.random_seed,
                           OLD.created_at) THEN
                        RAISE EXCEPTION 'Run inputs are immutable; create a new run.'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER api_run_inputs_immutable
                BEFORE UPDATE ON api_simulationrun
                FOR EACH ROW EXECUTE FUNCTION api_protect_run_inputs();
            """,
            reverse_sql="""
                DROP TRIGGER api_run_inputs_immutable ON api_simulationrun;
                DROP FUNCTION api_protect_run_inputs();
                DROP TRIGGER api_dataset_snapshot_immutable ON api_datasetsnapshot;
                DROP FUNCTION api_protect_dataset_snapshot();
            """,
        ),
    ]

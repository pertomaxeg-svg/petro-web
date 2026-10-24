-- Disposable-only acceptance gate for honest automated execution attribution.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='petro_finance_reservations' AND column_name='closed_by_system')
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='petro_inventory_movements' AND column_name='system_actor')
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='petro_inventory_reservations' AND column_name='completed_by_system') THEN
 RAISE EXCEPTION 'System execution attribution is missing'; END IF;
END $$;
ROLLBACK;

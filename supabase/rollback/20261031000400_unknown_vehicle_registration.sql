begin;
do $$begin execute (select definition from private.vehicle_registration_backup);end $$;
drop table private.vehicle_registration_backup;
commit;

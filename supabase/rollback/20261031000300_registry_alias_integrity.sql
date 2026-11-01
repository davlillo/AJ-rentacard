begin;
do $$begin execute (select definition from private.registry_validation_backup);end $$;
drop table private.registry_validation_backup;
commit;

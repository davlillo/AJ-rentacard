begin;
do $$declare item record;begin
  for item in select definition from private.fleet_availability_backups loop execute item.definition;end loop;
end $$;
drop table private.fleet_availability_backups;
commit;

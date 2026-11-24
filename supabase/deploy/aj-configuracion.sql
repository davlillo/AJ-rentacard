--
-- AJ Rentacar - configuracion inicial (cost_centers, workshop_tariffs, commission_rules)
-- EJECUTAR DESPUES de haber aplicado aj-esquema.sql y de haber creado la cuenta owner
-- en Authentication. No hay ningun valor que reemplazar a mano.
--

--
-- PostgreSQL database dump
--



-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: commission_rules; Type: TABLE DATA; Schema: public; Owner: postgres
--

--
-- Este bloque resuelve el usuario owner solo: no hay que reemplazar nada.
-- Requiere que ya exista una cuenta en Authentication (paso 3 del LEEME).
--
do $$
declare owner uuid;
begin
  select id into owner from auth.users order by created_at limit 1;
  if owner is null then
    raise exception 'Crea primero tu usuario en Authentication y volve a ejecutar este archivo.';
  end if;

  -- El rol owner es obligatorio: sin el la aplicacion abre pero no deja operar.
  insert into public.user_roles(user_id, role) values (owner, 'owner')
  on conflict (user_id, role) do nothing;

  INSERT INTO public.commission_rules (id, code, revision, rate, valid_from, valid_until, policy, created_by, created_at) VALUES ('015d8250-e215-4a49-977d-39d420d47cbe', 'SALE-9D3F28BF-BCCA-404D-B0BB-6F7B0B7AE35E', 1, 0.100000, '2020-01-01', '2040-01-01', 'net-applied-eligible-receipts-v1', owner, '2026-10-30 20:43:05.941746+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.commission_rules (id, code, revision, rate, valid_from, valid_until, policy, created_by, created_at) VALUES ('0b99e1fb-d6e0-43d9-a7ad-bac83a1347bb', 'SALE-B96C9660-B9D6-4869-A8E3-A168792DCECF', 1, 0.100000, '2020-01-01', '2040-01-01', 'net-applied-eligible-receipts-v1', owner, '2026-10-30 20:55:16.51128+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.commission_rules (id, code, revision, rate, valid_from, valid_until, policy, created_by, created_at) VALUES ('59330b45-b875-413f-86f7-f224699922ce', 'HTTP-86C36185-5077-4752-BBF7-FF0032ED8953', 1, 0.100000, '2020-01-01', '2040-01-01', 'net-applied-eligible-receipts-v1', owner, '2026-10-30 21:03:27.810528+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.commission_rules (id, code, revision, rate, valid_from, valid_until, policy, created_by, created_at) VALUES ('87bf84d3-f5c1-42b9-b8d4-b435beaf8397', 'SALE-509384F5-6E7C-48F5-BADF-E384E68AC78D', 1, 0.100000, '2020-01-01', '2040-01-01', 'net-applied-eligible-receipts-v1', owner, '2026-10-30 21:09:07.444111+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.commission_rules (id, code, revision, rate, valid_from, valid_until, policy, created_by, created_at) VALUES ('f2058b18-f336-49f2-adbd-c02cf6d57050', 'HTTP-81F45E4C-4E4F-4497-AAEA-0DC0513E61AA', 1, 0.100000, '2020-01-01', '2040-01-01', 'net-applied-eligible-receipts-v1', owner, '2026-10-30 21:09:14.396489+00') ON CONFLICT (id) DO NOTHING;
    --
    -- Data for Name: cost_centers; Type: TABLE DATA; Schema: public; Owner: postgres
    --

    INSERT INTO public.cost_centers (id, name) VALUES ('administration', 'Administración') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.cost_centers (id, name) VALUES ('workshop', 'Taller') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.cost_centers (id, name) VALUES ('rental', 'Renta') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.cost_centers (id, name) VALUES ('recover-9d3f28bf-bcca-404d-b0bb-6f7b0b7ae35e', 'Recovery destination') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.cost_centers (id, name) VALUES ('recover-b96c9660-b9d6-4869-a8e3-a168792dcecf', 'Recovery destination') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.cost_centers (id, name) VALUES ('recover-509384f5-6e7c-48f5-badf-e384e68ac78d', 'Recovery destination') ON CONFLICT (id) DO NOTHING;
    --
    -- Data for Name: workshop_tariffs; Type: TABLE DATA; Schema: public; Owner: postgres
    --

    INSERT INTO public.workshop_tariffs (id, code, revision, description, kind, unit_cost, unit_price, created_by, created_at) VALUES ('491ad4b8-784b-49fe-b727-f8b9aa7e4ceb', 'TEST-E1FEC194-BBE7-4F90-95F1-80F077A6D623', 1, 'HTTP repair', 'Trabajo', 250.0000, 350.0000, owner, '2026-10-30 20:42:52.261424+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.workshop_tariffs (id, code, revision, description, kind, unit_cost, unit_price, created_by, created_at) VALUES ('d3c369a7-6216-4f49-b027-45209715eb65', 'TEST-7DCA901E-4C1C-4B50-989A-06BD4C589FFC', 1, 'HTTP repair', 'Trabajo', 250.0000, 350.0000, owner, '2026-10-30 20:45:06.447509+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.workshop_tariffs (id, code, revision, description, kind, unit_cost, unit_price, created_by, created_at) VALUES ('02f05483-815c-4b70-897c-f0e584fe72b5', 'TEST-FBAD4C64-202B-4549-B2A6-A730263A5289', 1, 'HTTP repair', 'Trabajo', 250.0000, 350.0000, owner, '2026-10-30 20:55:02.584254+00') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.workshop_tariffs (id, code, revision, description, kind, unit_cost, unit_price, created_by, created_at) VALUES ('b57b07ec-5a30-43c2-8f92-0dd24fb90fd9', 'TEST-9AD71AD4-1067-4C2C-9B59-698A673C9FA1', 1, 'HTTP repair', 'Trabajo', 250.0000, 350.0000, owner, '2026-10-30 21:08:50.438146+00') ON CONFLICT (id) DO NOTHING;
    --
    -- PostgreSQL database dump complete
    --




    --
    -- ROL OWNER: la tabla public.user_roles empieza vacia en el proyecto hosteado y sin el
    -- rol 'owner' la aplicacion es inutilizable. Ejecutar esta sentencia despues de crear la
    -- cuenta dueno en Authentication y despues de reemplazar SU_CORREO_AQUI:
    --
    -- insert into public.user_roles(user_id, role) select id, 'owner' from auth.users where email = 'SU_CORREO_AQUI' ON CONFLICT (id) DO NOTHING;
    --
end $$;

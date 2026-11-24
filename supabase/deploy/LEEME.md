# Guía de despliegue en Supabase (proyecto hosteado)

Este paquete contiene dos archivos SQL para crear el proyecto AJ Rentacar en un
Supabase nuevo (hosteado en supabase.com):

- **`aj-esquema.sql`** — esquema completo (tablas, funciones, triggers, índices y
  políticas RLS) de los schemas `public` y `private`, sin las tablas de respaldo ni
  los artefactos de migraciones de la base local.
- **`aj-configuracion.sql`** — datos iniciales de configuración (6 centros de costo,
  4 tarifas de taller, 5 reglas de comisión).

## Pasos, en orden

1. **Crear el proyecto hosteado.** En supabase.com, crear un proyecto nuevo y
   esperar a que quede activo.

2. **Aplicar el esquema.** Abrir el *SQL Editor* del proyecto y ejecutar el
   contenido completo de `aj-esquema.sql`. Crea el schema `private`, las tablas,
   la extensión `btree_gist`, las funciones, los triggers y las políticas RLS.

3. **Crear la cuenta del dueño (owner).** En *Authentication → Users*, crear la
   cuenta del usuario dueño (email y contraseña reales). Este paso es
   **obligatorio antes** del paso 4.

4. **Cargar la configuración.** Abrir `aj-configuracion.sql` y:
   - reemplazar **todas** las apariciones de `SU_CORREO_AQUI` por el email real de
     la cuenta creada en el paso 3;
   - ejecutar el archivo en el *SQL Editor*.

5. **Asignar el rol owner.** Al final de `aj-configuracion.sql` está (comentada)
   esta sentencia:

   ```sql
   insert into public.user_roles(user_id, role) select id, 'owner' from auth.users where email = 'SU_CORREO_AQUI';
   ```

   Quitar el comentario (o copiarla) y ejecutarla **después** de reemplazar
   `SU_CORREO_AQUI`. La tabla `user_roles` empieza **vacía** en un proyecto nuevo:
   sin el rol `owner` la aplicación queda **inutilizable** porque RLS bloquea todo.

6. **Compilar la aplicación con las credenciales del proyecto hosteado.** El
   build actual tiene incrustadas las credenciales locales
   (`127.0.0.1:55321`). Hay que recompilar con:

   - `NEXT_PUBLIC_SUPABASE_URL` = URL del proyecto hosteado
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = clave *publishable* (anon)

7. **Desplegar el export estático** de la aplicación al hosting elegido.

8. **Configurar la autenticación en Supabase.** En *Authentication → URL
   Configuration*:
   - **Site URL**: el origen público de la app (por ejemplo `https://mi-dominio.com`).
   - **Redirect URLs**: agregar ese mismo origen (y variantes si corresponden).

## Notas importantes

- **Los archivos viajan en la base de datos**, en tablas del schema `private`
  (`private.vehicle_file_bytes`, `private.customer_document_bytes`), así que **no
  hace falta crear buckets de Storage**.
- **Solo la clave publishable viaja al navegador.** Nunca incluir la clave
  `service_role` en el build cliente.
- **Las políticas RLS ya vienen incluidas** en `aj-esquema.sql`; no hay que
  activarlas a mano.
- Los valores de `created_by` en `aj-configuracion.sql` se resuelven con un
  subselect contra `auth.users` (los UUID de la base local no existen en el
  proyecto hosteado). Por eso es obligatorio reemplazar `SU_CORREO_AQUI` antes de
  ejecutar el archivo.

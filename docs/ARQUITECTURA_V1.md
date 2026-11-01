# Arquitectura propuesta para la primera versión con Supabase

> Actualización del 22 de octubre de 2026: Supabase local funciona; HU01–HU04 y HU07 tienen pruebas SQL, API real y navegador. La importación de gastos implementa parte de HU05/HU06, no pagos. Existen cuatro migraciones aplicadas, adaptadores con Auth/RLS y una interfaz operativa separada del demo. El estado vigente está en [`ESTADO_HU.md`](ESTADO_HU.md) y [`LOCAL_SUPABASE.md`](LOCAL_SUPABASE.md), incluida la advertencia de puertos de Docker Desktop. Las afirmaciones históricas de «no implementado» siguientes describen el prototipo original.

Esta es una simplificación de la propuesta anterior. Para el primer producto operativo se propone Next.js, TypeScript, shadcn, Recharts y Supabase. Spring Boot, Python, Redis y Temporal pueden incorporarse posteriormente cuando exista un requisito que los justifique. Este repositorio entrega mockups ejecutables, no el backend operativo.

## Responsabilidades

| Capa | Responsabilidad |
| --- | --- |
| `app/<pantalla>/page.tsx` | Ruta y composición; componentes Server por defecto si no requieren estado |
| Atomic Design | UI reusable y experiencia responsive |
| `controladores` | Funciones de aplicación y cálculos de presentación; no constituye una frontera de seguridad |
| Supabase Auth | Sesiones e identidad del usuario |
| Supabase Data API | Lecturas y CRUD simples con grants y RLS |
| PostgreSQL/RPC | Reglas autoritativas, transacciones, reservas sin cruces, costos y pagos |
| Next Route Handlers o Edge Functions | Secreto del proveedor LLM, validación de tools, límites, autorización y streaming |
| Supabase Storage | Adjuntos con políticas de acceso y referencias a operación |

## El agente

El frontend aloja el chat, presenta resultados y recoge confirmaciones. Un endpoint de servidor invoca al modelo. El modelo recibe un catálogo de herramientas tipadas; las herramientas usan consultas o RPC autorizadas en Supabase con el contexto del usuario. El rol del usuario se valida en servidor/BD. No se entrega al modelo un service_role ni SQL arbitrario.

Flujo propuesto: chat → `/api/agente` o Edge Function `agente` → modelo → herramienta validada → Data API/RPC con identidad del usuario → datos/resultado → respuesta con referencias.

Si se mantiene la exportación estática de este prototipo, `/api/agente` no puede ejecutarse en ese hosting. Usar una Edge Function externa. Si se elige Next.js con servidor, quitar la exportación estática y crear `app/api/agente/route.ts`. Ambas variantes conservan la organización por pantalla.

## Herramientas y RPC por implementar

| Herramienta del agente | Acceso propuesto |
| --- | --- |
| consultar_vehiculos | Vista filtrada de vehículos y disponibilidad, RLS |
| consultar_cliente | Clientes y operaciones visibles para usuario |
| consultar_alquileres | Reservas y alquileres con rango y estados |
| consultar_expediente | Eventos y operaciones de un vehículo |
| consultar_costos | Vista calculada de costos por operación |
| consultar_cartera | Vista de saldos y vencimientos |
| crear_reserva | RPC `crear_reserva`, exclusión por vehículo e intervalo, idempotencia |
| registrar_gasto | RPC `registrar_gasto`, operación válida y auditoría |
| aplicar_pago | RPC `aplicar_pago`, límites de saldo y registro atómico |
| calcular_presupuesto | RPC/función de negocio determinista con tarifas versionadas |
| revisar_cierre | Reglas de tareas, costos, evidencia y excepciones |

No existe implementación de esas RPC en esta entrega. Las reglas locales permiten evaluar UX y no sustituyen seguridad ni concurrencia en BD.

## Migración del prototipo a producto

1. Revisar Excel reales y cerrar modelo de operaciones, pagos, costos, clientes y vehículos.
2. Crear proyecto Supabase, migraciones SQL y datos de prueba anonimizados.
3. Configurar Auth y roles. Definir grants y RLS por objeto, lectura, inserción, actualización y eliminación. Usuarios autenticados no equivale a todos los usuarios con acceso a todo.
4. Implementar RPC de reservar y pagar con transacciones, idempotencia, auditoría y pruebas concurrentes. Establecer permisos EXECUTE; preferir SECURITY INVOKER. Si se requiere SECURITY DEFINER, restringir roles, search_path y autorización interna.
5. Generar tipos de Supabase y adaptadores por dominio. Sustituir el store local pantalla por pantalla. Guardar filtros y preferencias en navegador; dinero y operaciones en BD.
6. Añadir adjuntos, estados y reglas de cierre. Cotización no es costo real; pago no crea otra vez el costo ni el cargo.
7. Añadir endpoint de agente con herramientas tipadas. Iniciar en consultas, medir exactitud de cifras y permisos y luego habilitar acciones revisables.
8. Antes de operar: probar dos reservas concurrentes, pago reintentado, sobrepago, denegación por usuario, restauración y saldos conciliados.

## Fuentes oficiales revisadas

- https://supabase.com/docs/guides/api/securing-your-api — grants y RLS en Data API.
- https://supabase.com/docs/guides/database/functions — funciones y permisos.
- https://nextjs.org/docs/app/guides/static-exports — limitaciones de exportación estática.
- https://ui.shadcn.com/docs/installation/next — integración de componentes.

Las recomendaciones de separación de responsabilidades son decisiones de este proyecto. No se conectó ningún proyecto Supabase ni proveedor de IA durante la creación de los mockups.

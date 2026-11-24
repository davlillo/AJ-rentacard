'use client';
import {useRef} from 'react';
import {Button} from '@/components/ui/button';
import {useCaseAction} from '@/hooks/use-case-action';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';
import type {Customer,Vehicle} from '@/types';

export function RegistryDetails({customer,vehicle,onChange,expanded=false}:{customer?:Customer;vehicle?:Vehicle;onChange:()=>Promise<void>;expanded?:boolean}){
  const {busy,error,execute}=useCaseAction(onChange);const record=customer??vehicle;
  const editVersion=useRef(record?.version);
  if(!record)return null;
  const fields=customer?[['name','Nombre o razón social'],['phone','Teléfono'],['email','Correo electrónico'],['document','Documento']]:
    [['plate','Placa'],['color','Color'],['km','Kilometraje confirmado'],['daily','Tarifa diaria (USD)']];
  return <details open={expanded} className="mt-5"><summary className="text-link">{customer?'Editar datos del cliente':'Completar o corregir datos'}</summary><form key={record.id} className="operation-form mt-4" onSubmit={event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);if(!form.get('status'))form.delete('status');const payload={id:record.id,expectedVersion:editVersion.current,
      ...Object.fromEntries(form.entries())};const kind=customer?'customer':'vehicle';
    void execute('registry.'+kind,payload,async key=>{
      const {data,error}=await createSupabaseBrowserClient().rpc('save_registry_details',{kind,payload,idempotency_key:key});
      if(error){const messages:Record<string,string>={VERSION_CONFLICT:'El registro cambió. Actualice antes de guardar.',
        CONFIRMED_ODOMETER_REQUIRED:'Confirme el kilometraje antes de declarar el vehículo disponible.',
        PHYSICAL_STATUS_REQUIRES_WORKFLOW:'El vehículo tiene una operación activa. Registre su devolución o salida en el expediente.',
        ODOMETER_CANNOT_DECREASE:'El kilometraje no puede disminuir.',CUSTOMER_MATCH_EXISTS:'El teléfono o documento ya pertenece a otra ficha. Revise las coincidencias.'};
        throw new Error(messages[error.message]??'No se pudo guardar. Revise los datos y la conexión.');}
      editVersion.current=data.version;
    });
  }}><fieldset disabled={busy} className="contents"><div className="form-grid">{fields.map(([key,label])=><label className="form-field" key={key}><span>{label}</span><input name={key}
    type={key==='email'?'email':key==='phone'?'tel':['km','daily'].includes(key)?'number':'text'} required={key==='name'}
    min={key==='km'?vehicle?.km:0} step={key==='daily'?'0.01':'1'}
    defaultValue={vehicle?.unverified_fields?.includes(key)?'':String(record[key as keyof typeof record]??'')}/></label>)}</div>
    {customer&&<label className="form-field"><span>Tipo de cliente</span><select name="type" defaultValue={customer.type}><option>Personal</option><option>Empresa</option></select></label>}
    {vehicle?.status==='Por confirmar'&&<label className="form-field"><span>Disponibilidad del vehículo</span><select name="status" defaultValue=""><option value="">Conservar el estado actual</option><option value="Disponible">Confirmar disponible</option></select></label>}
    <label className="form-field"><span>Motivo o evidencia de la corrección *</span><textarea name="reason" required placeholder="Ej. verificación de documentos o inspección del vehículo"/></label>
    <Button type="submit" disabled={busy}>{busy?'Guardando…':customer?'Guardar cambios del cliente':'Guardar datos verificados'}</Button></fieldset>
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form></details>;
}

'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {Check,CarFront,UserRound,ClipboardCheck} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {CustomerRegistrationDialog} from './operational-dialog';
import {eligibleIntakeVehicles,intakeProposal,intakeProgress,IntakeAttempt,type IntakeDraft} from '@/controladores/workshop-intake';
import {orderHref} from '@/lib/supabase/cases';
import {folio} from '@/controladores/folios';
import styles from './workshop-intake.module.css';

const emptyVehicle={plate:'',brand:'',model:'',year:'',color:'',category:'Sedán'};

export function WorkshopIntake(){
  const {data,modal,can,command,close,refresh}=useBusiness();
  const initial=data.vehicles.find(car=>car.id===modal.id);
  const [draft,setDraft]=useState<IntakeDraft>({
    internalJob:!!initial?.inRentalFleet,customerId:'',vehicleId:initial?.id??'',
    service:'',area:'Mecánica',due:'',newVehicle:null,
  });
  const [step,setStep]=useState(0);
  const [registering,setRegistering]=useState(false);
  const [createdCustomer,setCreatedCustomer]=useState<{id:string;name:string}|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [orderId,setOrderId]=useState('');
  const [locked,setLocked]=useState(false);
  const attempt=useRef(new IntakeAttempt());
  const proposal=useRef<ReturnType<typeof intakeProposal>|null>(null);
  const selectedVersion=useRef(initial?.version);
  const set=(patch:Partial<IntakeDraft>)=>setDraft(current=>({...current,...patch}));
  const eligible=eligibleIntakeVehicles(data.vehicles,data.orders,draft.internalJob);
  const customer=data.customers.find(row=>row.id===draft.customerId)??(createdCustomer?.id===draft.customerId?createdCustomer:null);
  const vehicle=eligible.find(row=>row.id===draft.vehicleId);
  const vehicleReady=!!(draft.newVehicle?draft.newVehicle.brand.trim()&&draft.newVehicle.model.trim()&&
    Number(draft.newVehicle.year)>=1900&&Number(draft.newVehicle.year)<=2100:vehicle);
  const identityReady=draft.internalJob||!!customer;
  const progress=intakeProgress(identityReady,vehicleReady,!!orderId);
  const steps=draft.internalJob?['Tipo de trabajo','Vehículo de flota','Crear folio OT']:['Cliente','Vehículo y datos','Crear folio OT'];
  const switchType=(internalJob:boolean)=>{
    set({internalJob,vehicleId:'',newVehicle:null});selectedVersion.current=undefined;setStep(0);
  };
  async function submit(){
    if(busy||orderId)return;
    setError('');
    try{
      if(!identityReady)throw new Error('Seleccione un cliente activo.');
      if(!proposal.current){
        const cars=data.vehicles.map(car=>car.id===draft.vehicleId?{...car,version:selectedVersion.current}:car);
        proposal.current=intakeProposal(draft,cars,data.orders,can);
      }
      // Recheck current permissions even when replaying a request after a lost response.
      if(!can('orders.write')||(proposal.current.payload.newVehicle&&!can('vehicles.write'))){
        throw new Error('No tiene permiso para registrar esta entrada.');
      }
      setBusy(true);setLocked(true);
      const result=await attempt.current.submit(proposal.current,command);
      if(result)setOrderId(result.id);
    }catch(cause){setError((cause as Error).message);}
    finally{setBusy(false);}
  }
  return <>
    <Dialog open onOpenChange={open=>!open&&!busy&&!registering&&close()}>
      <DialogContent className={styles.dialog} closeDisabled={busy||registering} data-testid="workshop-intake">
        <header className={styles.header}><span className={styles.eyebrow}>TALLER / NUEVA ENTRADA</span>
          <DialogTitle className={styles.title}>{orderId?'Folio creado':'Primero, identifiquemos la entrada'}</DialogTitle>
          <DialogDescription>Cliente y vehículo → folio independiente → diagnóstico del trabajo.</DialogDescription>
        </header>
        <ol className={styles.steps} aria-label="Progreso de la entrada">
          {steps.map((label,index)=><li key={label} data-complete={progress>index} aria-current={!orderId&&step===index?'step':undefined}>
            <span className={styles.circle} aria-hidden="true">{progress>index?<Check size={17}/>:index+1}</span>
            <span>{label}</span>
          </li>)}
        </ol>
        {orderId?<section className={styles.success} role="status"><ClipboardCheck size={32}/>
          <h2>{folio('OT',orderId)}</h2><p>La entrada quedó registrada. Continúe con la recepción y el diagnóstico en el folio.</p>
          <Button asChild><Link href={orderHref(orderId)} onClick={close}>Abrir folio OT</Link></Button>
        </section>:<form onSubmit={event=>{event.preventDefault();if(step<2)setStep(step+1);else void submit();}}>
          <fieldset disabled={busy||locked} className={styles.fields}>
            <section hidden={step!==0}>
              <div className={styles.types} aria-label="Tipo de entrada">
                <button type="button" aria-pressed={!draft.internalJob} onClick={()=>switchType(false)}>
                  <UserRound size={20}/><strong>Cliente del taller</strong><small>Vehículo fuera de la flota de alquiler</small>
                </button>
                <button type="button" aria-pressed={draft.internalJob} onClick={()=>switchType(true)}>
                  <CarFront size={20}/><strong>Mantenimiento interno</strong><small>Vehículo de la flota · sin venta a cliente</small>
                </button>
              </div>
              {draft.internalJob?<p className={styles.note}>No necesita cliente ni precio de venta. La propiedad del vehículo y su pertenencia a la flota son datos independientes.</p>:<>
                <label className="form-field"><span>Cliente del trabajo</span><select aria-label="Cliente del trabajo" value={draft.customerId} onChange={e=>set({customerId:e.target.value})}>
                  <option value="">Seleccionar cliente</option>
                  {data.customers.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
                  {createdCustomer&&!data.customers.some(row=>row.id===createdCustomer.id)&&<option value={createdCustomer.id}>{createdCustomer.name}</option>}
                </select></label>
                <Button type="button" variant="outline" disabled={!can('customers.write')} onClick={()=>setRegistering(true)}>Registrar nuevo cliente</Button>
                <p className={styles.note}>El cliente se guarda en su propia ficha. Los datos de esta entrada se conservan mientras lo registra.</p>
              </>}
            </section>
            <section hidden={step!==1}>
              <h2 className={styles.sectionTitle}>{draft.internalJob?'Seleccione un vehículo de la flota':'Identifique el vehículo del cliente'}</h2>
              {!draft.internalJob&&<label className="form-field"><span>Vehículo del cliente</span><select aria-label="Vehículo del cliente" value={draft.newVehicle?'new':'existing'} onChange={e=>set({newVehicle:e.target.value==='new'?{...emptyVehicle}:null})}>
                <option value="existing">Seleccionar vehículo registrado</option><option value="new" disabled={!can('vehicles.write')}>Registrar vehículo nuevo con la entrada</option>
              </select></label>}
              {draft.newVehicle&&!draft.internalJob?<>
                <p className={styles.note}>Se registrará a nombre del cliente y fuera de la flota, junto con el folio OT. No necesita tarifa de alquiler.</p>
                <div className={styles.vehicleFields}>{(['plate','brand','model','year','color'] as const).map(key=>
                  <label className="form-field" key={key}><span>{{plate:'Placa (si se conoce)',brand:'Marca',model:'Modelo',year:'Año',color:'Color (opcional)'}[key]}</span>
                    <input name={key} value={draft.newVehicle![key]} type={key==='year'?'number':'text'} min={key==='year'?1900:undefined} max={key==='year'?2100:undefined}
                      maxLength={key==='plate'?30:100} onChange={e=>set({newVehicle:{...draft.newVehicle!,[key]:e.target.value}})}/>
                  </label>)}
                  <label className="form-field"><span>Categoría</span><select value={draft.newVehicle.category} onChange={e=>set({newVehicle:{...draft.newVehicle!,category:e.target.value}})}>
                    {['Sedán','SUV','Pickup','Compacto'].map(value=><option key={value}>{value}</option>)}
                  </select></label>
                </div>
              </>:<><label className="form-field"><span>{draft.internalJob?'Vehículo de flota disponible':'Vehículo registrado del taller'}</span>
                <select aria-label={draft.internalJob?'Vehículo de flota disponible':'Vehículo registrado del taller'} value={draft.vehicleId} onChange={e=>{set({vehicleId:e.target.value});selectedVersion.current=data.vehicles.find(car=>car.id===e.target.value)?.version;}}>
                  <option value="">Seleccionar vehículo</option>{eligible.map(car=><option value={car.id} key={car.id}>{car.plate||'Sin placa'} · {car.brand} {car.model}</option>)}
                </select></label>
                {vehicle&&<dl className={styles.identity}><div><dt>Relación de propiedad</dt><dd>{vehicle.ownership??'Por confirmar'}</dd></div>
                  <div><dt>Flota de alquiler</dt><dd>{vehicle.inRentalFleet?'Sí':'No'}</dd></div></dl>}
                <p className={styles.note}>Solo aparecen vehículos disponibles sin otro trabajo abierto. Si ya existe un presupuesto, continúe la recepción en ese folio.</p>
              </>}
            </section>
            <section hidden={step!==2}>
              <h2 className={styles.sectionTitle}>Revise la entrada y cree su folio</h2>
              <p className={styles.note}><strong>{draft.internalJob?'Mantenimiento interno':customer?.name}</strong><br/>
                {draft.newVehicle?`${draft.newVehicle.plate||'Sin placa'} · ${draft.newVehicle.brand} ${draft.newVehicle.model}`:`${vehicle?.plate||'Sin placa'} · ${vehicle?.brand??''} ${vehicle?.model??''}`}</p>
              <label className="form-field"><span>Motivo del ingreso</span><textarea name="service" maxLength={2000} value={draft.service} onChange={e=>set({service:e.target.value})}/></label>
              <div className={styles.vehicleFields}><label className="form-field"><span>Área</span><select value={draft.area} onChange={e=>set({area:e.target.value})}><option>Mecánica</option><option>Pintura</option></select></label>
                <label className="form-field"><span>Fecha objetivo (opcional)</span><input type="date" value={draft.due} onChange={e=>set({due:e.target.value})}/></label></div>
              <p className={styles.note}>Esta acción registra el ingreso, no un presupuesto sin recepción. El diagnóstico y la inspección se completan en el folio; no requieren aprobación de un presupuesto.</p>
            </section>
          </fieldset>
          {error&&<p className="form-error" role="alert">{error}</p>}
          {locked&&error&&<p className={styles.note}>Sus datos se conservan. Reintentar recupera exactamente la misma solicitud, sin crear otra entrada.</p>}
          {locked&&error.includes('registro cambió')&&<Button type="button" variant="outline" disabled={busy} onClick={async()=>{
            setBusy(true);try{await refresh();attempt.current.resetAfterVersionConflict();proposal.current=null;
              setLocked(false);setStep(1);set({vehicleId:''});setError('Seleccione nuevamente el vehículo actualizado.');
            }catch{setError('No se pudo actualizar. Sus datos se conservan.');}finally{setBusy(false);}
          }}>Actualizar vehículo y revisar</Button>}
          <footer className={styles.footer}>
            <Button type="button" variant="outline" disabled={busy} onClick={()=>step>0&&!locked?setStep(step-1):close()}>{step>0&&!locked?'Atrás':'Cerrar'}</Button>
            <Button type="submit" disabled={busy||!can('orders.write')||
              (!locked&&(step===0?!identityReady:step===1?!vehicleReady:!draft.service.trim()||!vehicleReady||!identityReady))}>
              {busy?'Guardando…':locked?'Reintentar misma entrada':step===2?'Crear folio OT':'Continuar'}
            </Button>
          </footer>
        </form>}
      </DialogContent>
    </Dialog>
    {registering&&<CustomerRegistrationDialog onClose={()=>setRegistering(false)} onSaved={id=>{
      setCreatedCustomer({id,name:'Cliente recién registrado'});set({customerId:id});setRegistering(false);
    }}/>}
  </>;
}

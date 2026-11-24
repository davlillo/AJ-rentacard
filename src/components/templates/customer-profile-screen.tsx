'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useEffect,useState} from 'react';
import {ArrowLeft,ArrowUpRight,CarFront,Check,FileText,Mail,PencilLine,Phone,ShieldCheck,Wallet,Wrench} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {RegistryDetails} from '@/components/organisms/registry-details';
import {CustomerDocuments} from '@/components/organisms/customer-documents';
import {CustomerMerge} from '@/components/organisms/customer-merge';
import {Badge} from '@/components/atoms/badge';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {customerDocumentsAt,customerHref,customerMissingFields,customerOperations,customerRentalStages,
  customerSection,customerSections,customerVehicles,customerWorkshopStages,type CustomerSection} from '@/controladores/customer-profile';
import {initials} from '@/controladores/reportes';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {dashboardReceivables} from '@/controladores/dashboard';
import {billingRpc,localToday,type Receivable} from '@/lib/supabase/billing';
import {vehicleHref} from '@/lib/supabase/cases';
import {rentalDateTime} from '@/controladores/rental-workflow';
import styles from './customer-profile.module.css';

export function CustomerProfileScreen(){
  const search=useSearchParams();
  const id=search.get('id')??'';
  const section=customerSection(search.get('seccion'));
  return <CustomerProfile key={id} id={id} section={section}/>;
}

function CustomerProfile({id,section}:{id:string;section:CustomerSection}){
  const {data,can,source,refresh,open}=useBusiness();
  const customer=data.customers.find(customer=>customer.id===id);
  const [kind,setKind]=useState<'Taller'|'Alquiler'>('Taller');
  const [stage,setStage]=useState('Todas');
  const [query,setQuery]=useState('');
  const [financial,setFinancial]=useState<{documents?:Receivable[];error:string}>({error:''});
  const [retry,setRetry]=useState(0);
  const finance=can('expenses.read')&&source==='supabase';
  const today=localToday();
  useEffect(()=>{
    if(!finance||!customer)return;
    let active=true;
    void billingRpc<Receivable[]>('receivables_at',{cutoff:today}).then(documents=>{
      if(active)setFinancial({documents:customerDocumentsAt(documents,id),error:''});
    }).catch(()=>{if(active)setFinancial(previous=>({...previous,error:'No se pudieron actualizar los saldos. Reintente la consulta.'}));});
    return()=>{active=false;};
  },[finance,id,today,data,retry,!!customer]);
  const profileData=source==='demo'?{...data,reservationHistory:data.rentals.map(rental=>({...rental,
    rentalState:rental.status==='En curso'?'Entregado':rental.status==='Finalizada'?'Cerrado':'Preparado',
    status:rental.status==='Cancelada'?'Cancelada':'Confirmada'}))}:data;
  const operations=can('orders.read')?customerOperations(profileData,id):[];
  const vehicles=customerVehicles(data.vehicles,operations,id);
  const customerJobs=operations.filter(operation=>operation.kind==='Taller');
  const rentals=operations.filter(operation=>operation.kind==='Alquiler');
  const stages=kind==='Taller'?customerWorkshopStages:customerRentalStages;
  const current=operations.filter(operation=>operation.kind===kind&&(stage==='Todas'||operation.stage===stage));
  const documents=financial.documents?.filter(document=>
    `${document.description} ${folio('DOC',document.folio_number)} ${document.external_reference??''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const documentPage=usePagination(documents??[],query+id,10);
  const operationPage=usePagination(current,id+kind+stage,6);
  const balances=financial.documents?dashboardReceivables(financial.documents):undefined;
  if(!customer)return <section className={styles.missing} role="alert"><h1>Cliente no disponible</h1>
    <p>{id?'La ficha no existe, fue fusionada o no está disponible para tu usuario.':'Falta el identificador del cliente.'}</p>
    <Link href="/clientes">Volver a clientes</Link></section>;
  const missing=customerMissingFields(customer);
  return <div className={styles.profile}>
    <Link href="/clientes" className={styles.back}><ArrowLeft size={16}/>Volver a clientes</Link>
    <PageHeading title={customer.name} variant="identity"
      actions={can('customers.write')?<Button asChild variant="outline" size="icon" className="compact-edit"><Link
        href={customerHref(id,'Datos y documentos')} aria-label="Editar datos del cliente" data-tooltip="Editar datos del cliente"><PencilLine size={17} aria-hidden="true"/></Link></Button>:undefined}/>
    <div className={styles.layout}>
      <aside className={styles.identity} aria-label="Datos principales del cliente">
        <span className={styles.avatar} aria-hidden="true">{initials(customer.name)}</span><Badge tone={customer.type==='Empresa'?'blue':'green'}>{customer.type}</Badge>
        <dl><div><dt><Phone size={15}/>Teléfono</dt><dd>{customer.phone||'Sin registrar'}</dd></div>
          <div><dt><Mail size={15}/>Correo electrónico</dt><dd>{customer.email||'Sin registrar'}</dd></div>
          <div><dt><ShieldCheck size={15}/>Documento</dt><dd>{customer.document||'Sin registrar'}</dd></div></dl>
        {missing.length>0?<div className={styles.pending}><strong>Datos por completar</strong><p>{missing.join(' · ')}</p>
          {can('customers.write')&&<Link href={customerHref(id,'Datos y documentos')}>Completar ficha <ArrowUpRight size={14}/></Link>}</div>:
          <p className={styles.complete}><Check size={15}/>Datos de contacto registrados</p>}
      </aside>
      <div className={styles.content}>
        <div className={styles.metrics} aria-label="Resumen del cliente">
          {can('orders.read')&&<><article><Wrench size={18}/><span>Taller en curso</span><strong>{customerJobs.filter(operation=>operation.active).length}</strong></article>
            <article><CarFront size={18}/><span>Alquileres en curso</span><strong>{rentals.filter(operation=>operation.active).length}</strong></article></>}
          {can('vehicles.read')&&<article><CarFront size={18}/><span>Vehículos vinculados</span><strong>{vehicles.length}</strong></article>}
          {finance&&<article><Wallet size={18}/><span>Saldo por cobrar</span><strong>{balances?money(balances.balance):'—'}</strong></article>}
        </div>
        {finance&&financial.error&&<div className={styles.error} role="alert"><p>{financial.error}{financial.documents&&' Los importes corresponden a la última lectura disponible.'}</p>
          <Button variant="outline" onClick={()=>setRetry(value=>value+1)}>Reintentar saldos</Button></div>}
        <nav className={styles.sections} aria-label="Secciones del cliente">{customerSections.filter(item=>
          (item!=='Cobros'||finance)&&(item!=='Vehículos'||can('vehicles.read'))).map(item=>
          <Link key={item} href={customerHref(id,item)} scroll={false} replace aria-current={section===item?'page':undefined}>{item}</Link>)}</nav>

        {section==='Operaciones'&&<section className={styles.panel} aria-label="Operaciones del cliente">
          {can('orders.read')?<><div className={styles.kinds} role="group" aria-label="Tipo de operación del cliente">
            {(['Taller','Alquiler'] as const).map(value=><button key={value} type="button" aria-pressed={kind===value}
              onClick={()=>{setKind(value);setStage('Todas');}}>{value==='Taller'?<Wrench size={16}/>:<CarFront size={16}/>}{value==='Alquiler'?'Alquileres':value}
              <b>{operations.filter(operation=>operation.kind===value).length}</b></button>)}</div>
            <div className={styles.pipeline} aria-label={`Etapas de ${kind.toLowerCase()}`}>
              {stages.filter(value=>value!=='Por revisar'||operations.some(operation=>operation.kind===kind&&operation.stage==='Por revisar')).map((value,index)=><button type="button" key={value}
                aria-pressed={stage===value} onClick={()=>setStage(stage===value?'Todas':value)}>
                <span>{String(index+1).padStart(2,'0')}</span><strong>{operations.filter(operation=>operation.kind===kind&&operation.stage===value).length}</strong>
                <b>{value}</b></button>)}
            </div>
            <div className={styles.listHeading}><h2>{stage==='Todas'?'Todas las operaciones':stage} <span>· {current.length}</span></h2>
              {stage!=='Todas'&&<button type="button" onClick={()=>setStage('Todas')}>Ver todas las etapas</button>}</div>
            <div className={styles.operations}>{operationPage.items.map(operation=>{
              const vehicle=data.vehicles.find(vehicle=>vehicle.id===operation.vehicleId);
              return <article key={operation.kind+operation.id}><div className={styles.operationTitle}>
                <span className={styles.operationIcon}>{operation.kind==='Taller'?<Wrench size={19}/>:<CarFront size={19}/>}</span>
                <div><strong>{operation.label} <span>· {vehicle?.plate||'Sin placa'}</span></strong><p>{operation.description}</p></div>
                <Badge tone={operation.active?'blue':'gray'}>{operation.stage}</Badge></div>
                <div className={styles.operationFooter}><span>{operation.kind==='Taller'&&operation.stage==='Presupuesto'?'Sin recepción física':
                  operation.kind==='Alquiler'&&['Borrador','Reservado'].includes(operation.stage)?'Sin salida física registrada':
                    operation.date?`${operation.kind==='Taller'?'Ingreso':'Inicio previsto'}: ${rentalDateTime(operation.date)}`:'Fecha sin registrar'}</span>
                  <Link href={operation.href}>Ver expediente <ArrowUpRight size={15}/></Link></div>
              </article>;
            })}</div>
            {!current.length&&<p className={styles.empty}>No hay operaciones en esta etapa.</p>}
            <Pagination {...operationPage}/>
            <p className={styles.note}>Un presupuesto aprobado no confirma recepción física. Una reserva confirmada no significa que el vehículo ya salió.</p>
          </>:<p className={styles.empty}>Las operaciones requieren permiso de lectura de taller y alquileres.</p>}
          {source==='demo'&&<Button onClick={()=>open('reserva')}>Crear una reserva</Button>}
        </section>}

        {section==='Vehículos'&&can('vehicles.read')&&<section className={styles.panel} aria-labelledby="customer-vehicles-heading">
          <header><h2 id="customer-vehicles-heading">Vehículos vinculados</h2><p>Propiedad registrada o relación con una operación. Un alquiler no convierte al cliente en propietario.</p></header>
          <div className={styles.vehicleList}>{vehicles.map(vehicle=><article key={vehicle.id}><CarFront size={22}/><div><h3>{vehicle.plate||'Sin placa'} · {vehicle.brand} {vehicle.model}</h3>
            <p>{vehicle.ownerCustomerId===id?'Propietario registrado':'Relacionado por una operación'} · {vehicle.inRentalFleet?'Flota de alquiler':'Fuera de la flota de alquiler'}</p>
            <Link href={vehicleHref(vehicle.id)}>Ver expediente del vehículo <ArrowUpRight size={15}/></Link></div></article>)}</div>
          {!vehicles.length&&<p className={styles.empty}>No hay vehículos vinculados a esta ficha.</p>}
        </section>}

        {section==='Datos y documentos'&&<div className={styles.dataSections}>
          <section className={styles.panel}><header><h2>Datos del cliente</h2><p>Completa o corrige la ficha sin perder sus operaciones ni su historial.</p></header>
            <div className={styles.formBody}>{source==='supabase'&&can('customers.write')?
              <RegistryDetails key={id} customer={customer} onChange={refresh} expanded/>:<p>Tu usuario no tiene permiso para editar estos datos.</p>}</div></section>
          <section className={styles.panel}><header><h2>Documentos de identidad</h2><p>Fotos privadas de DUI y licencia. No se comparten con presupuestos ni galerías de vehículos.</p></header>
            <div className={styles.formBody}>{source==='supabase'&&can('customers.write')?<CustomerDocuments key={id} customerId={id} customerName={customer?.name}/>:
              <p>Los documentos personales están restringidos al personal autorizado que administra clientes.</p>}</div></section>
          {!!customer.aliases?.length&&<section className={styles.panel}><header><h2>Fichas fusionadas conservadas</h2></header><div className={styles.formBody}>
            {customer.aliases.map((alias,index)=><p key={index}>{alias.name} · {alias.phone} · {alias.document}</p>)}</div></section>}
          {source==='supabase'&&can('customers.merge')&&<section className={styles.panel}><div className={styles.formBody}><CustomerMerge customer={customer}/></div></section>}
        </div>}

        {section==='Cobros'&&<section className={styles.panel} aria-labelledby="customer-billing-heading">
          <header><h2 id="customer-billing-heading">Cobros y saldos del cliente</h2><p>Documentos emitidos al {today}. Los presupuestos no se suman como deuda.</p></header>
          {finance?<><div className={styles.billingSummary}><div><span>Saldo por cobrar</span><strong>{balances?money(balances.balance):'—'}</strong></div>
            <div><span>Saldo vencido</span><strong>{balances?money(balances.overdueBalance):'—'}</strong></div></div>
            <label className={styles.search}>Buscar documento<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Descripción, folio o referencia"/></label>
            {!financial.documents&&<p role="status" className={styles.empty}>{financial.error?'Saldos no disponibles.':'Consultando documentos…'}</p>}
            <div className={styles.documentList}>{documentPage.items.map(document=><article key={document.id}><FileText size={21}/>
              <div><strong>{folio('DOC',document.folio_number)}</strong><h3>{document.description}</h3><p>Vence: {document.due_on} · {Number(document.balance)<=0?'Sin saldo pendiente':Number(document.days_overdue)>0?'Vencido':'Dentro del plazo'}</p>
                {document.external_reference&&<p>Referencia: {document.external_reference}</p>}
                <span>Emitido: {money(Number(document.amount))} · Saldo: <b>{money(Number(document.balance))}</b></span>
                {(document.order_id||document.reservation_id)&&<Link href={'/cobros/?'+new URLSearchParams({operacion:document.order_id??document.reservation_id!})}>Ver documentos y pagos de la operación <ArrowUpRight size={15}/></Link>}
                {!document.order_id&&!document.reservation_id&&<Link href="/cobros">Ver todos los cobros <ArrowUpRight size={15}/></Link>}
                {document.grouped&&<p>Documento compartido: el saldo corresponde al documento completo.</p>}</div></article>)}</div>
            {financial.documents&&!documents?.length&&<p className={styles.empty}>No hay documentos en esta vista.</p>}
            <Pagination {...documentPage}/><p className={styles.note}>Los abonos, aplicaciones y recibos se consultan en cada operación. El saldo no equivale a dinero recibido en caja.</p>
          </>:<p className={styles.empty}>Tu usuario no tiene permiso para consultar información financiera.</p>}
        </section>}
      </div>
    </div>
  </div>;
}

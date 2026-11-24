const moduleTitles=new Set(['Taller','Presupuestos','Cobros','Libro diario','Clientes','Calendario','Alquileres','Vehículos','Inicio','Resumen del negocio']);

export function PageHeading({eyebrow,title,description,actions,variant}:{eyebrow?:string;title:string;description?:string;actions?:React.ReactNode;variant?:'module'|'identity'}){
  const module=variant==='module'||(variant!=='identity'&&moduleTitles.has(title));
  return <div className={`page-heading${module?' page-heading-module':''}`}><div className="page-heading-intro">{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description&&<p>{description}</p>}</div>{actions&&<div className="heading-actions">{actions}</div>}</div>;
}

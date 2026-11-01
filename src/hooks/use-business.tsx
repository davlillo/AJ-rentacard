'use client';
import {createContext, useContext, useState, useEffect, useCallback, useRef} from 'react';
import type {Session} from '@supabase/supabase-js';
import {seed} from '@/datos/demo';
import type {BusinessData, ModalState} from '@/types';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';
import {emptyBusiness, executeCommand, loadBusiness, type BusinessCommand, type CommandResult} from '@/lib/supabase/business';
import {SessionForm} from '@/components/organisms/session-form';
import {Button} from '@/components/ui/button';

const STORAGE = 'rentia-demo-v1';
const live = process.env.NEXT_PUBLIC_DATA_SOURCE === 'supabase';
interface Context {
  data: BusinessData;
  update: (fn: (data: BusinessData) => BusinessData) => void;
  modal: ModalState;
  open: (kind: ModalState['kind'], id?: string) => void;
  close: () => void;
  toast: (message: string) => void;
  notice: string;
  reset: () => void;
  source: 'demo' | 'supabase';
  can: (permission: string) => boolean;
  command: (name: BusinessCommand, payload: Record<string, unknown>, key: string) => Promise<CommandResult>;
  refresh: () => Promise<void>;
}
const C = createContext<Context | null>(null);
const modalPermissions: Partial<Record<NonNullable<ModalState['kind']>, string>> = {
  cliente: 'customers.write', vehiculo: 'vehicles.write', orden: 'orders.write', gasto: 'expenses.write', importar: 'expenses.write',
};

function reportSessionError(error:unknown):void{
  const cause=error instanceof Error&&error.cause?error.cause:error;
  const details=typeof cause==='object'&&cause!==null?cause:{};
  // Log only diagnostic codes, never tokens, credentials or returned business data.
  console.warn('Operational session load failed',{
    code:'code' in details?String(details.code):'CONNECTION_ERROR',
    status:'status' in details?details.status:undefined,
    resource:'resource' in details?details.resource:undefined,
  });
}

export function BusinessProvider({children}: {children: React.ReactNode}) {
  const [data, setData] = useState<BusinessData>(live ? emptyBusiness : seed);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [workspaceUser,setWorkspaceUser]=useState<string|null>(null);
  const [modal, setModal] = useState<ModalState>({kind: null});
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [checking,setChecking]=useState(false);
  const [recovering,setRecovering]=useState(false);
  const [retryVersion,setRetryVersion]=useState(0);
  const recoveryInFlight=useRef(false);
  const sessionId = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (!live) return;
    const userId = sessionId.current;
    if (!userId) return;
    const next = await loadBusiness();
    if (sessionId.current === userId) {setData(next); setLoadError('');}
  }, []);

  useEffect(() => {
    if (!live) {
      try {
        const raw = localStorage.getItem(STORAGE);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.vehicles && parsed.customers && parsed.rentals && parsed.orders &&
              parsed.items && parsed.estimates && parsed.movements) setData(parsed);
        }
      } catch {setNotice('No se pudo recuperar la demostración local.');}
      setReady(true);
      return;
    }
    const client = createSupabaseBrowserClient();
    const {data: listener} = client.auth.onAuthStateChange((_event, next) => {
      sessionId.current = next?.user.id ?? null;
      setSession(next);
      if (!next) {setData(emptyBusiness); setPermissions([]); setWorkspaceUser(null);setModal({kind: null});setLoadError('');}
      setReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!live || !session) return;
    let active = true;
    let running=false;
    const check = async () => {
      if(!active||running)return;
      running=true;setChecking(true);
      try {
        const available = ['customers.read','customers.write','customers.merge','vehicles.read',
          'vehicles.write','orders.read','orders.write','expenses.read','expenses.write','tasks.read','administration.write'];
        const responses = await Promise.all(available.map(async permission => {
          const {data, error} = permission === 'tasks.read'
            ? await createSupabaseBrowserClient().rpc('has_task_access')
            : await createSupabaseBrowserClient().rpc('has_permission', {permission});
          if (error) throw error;
          return data ? permission : '';
        }));
        const next=await loadBusiness();
        if(active&&sessionId.current===session.user.id){
          setPermissions(responses.filter(Boolean));setData(next);setLoadError('');setWorkspaceUser(session.user.id);
        }
      } catch(error){if(active){
        reportSessionError(error);
        setLoadError('No se pudo cargar la sesión operativa. Reintente o vuelva a ingresar.');
      }}finally{running=false;if(active)setChecking(false);}
    };
    void check();
    const timer = setInterval(() => {void check();}, 15000);
    window.addEventListener('focus', check);
    window.addEventListener('online',check);
    return () => {
      active=false;clearInterval(timer);window.removeEventListener('focus',check);window.removeEventListener('online',check);
    };
  }, [session?.user.id,session?.access_token,retryVersion]);

  async function recoverSession(signOut=false):Promise<void>{
    if(recoveryInFlight.current)return;
    const userId=sessionId.current;
    recoveryInFlight.current=true;setRecovering(true);
    try{
      const client=createSupabaseBrowserClient();
      if(signOut){
        // Do not invalidate the user's sessions on other browsers or devices.
        const {error}=await client.auth.signOut({scope:'local'});
        if(error&&sessionId.current)throw error;
      }else{
        // Renew a persisted token before retrying permissions and the complete workspace load.
        const {data,error}=await client.auth.refreshSession();
        if(error)throw error;
        if(!data.session){await client.auth.signOut({scope:'local'});return;}
        setRetryVersion(version=>version+1);
      }
    }catch(error){
      reportSessionError(error);
      if(sessionId.current===userId)setLoadError('No se pudo recuperar la sesión. Reintente o vuelva a ingresar.');
    }finally{recoveryInFlight.current=false;setRecovering(false);}
  }

  useEffect(() => {
    if (!live && ready) {
      try {localStorage.setItem(STORAGE, JSON.stringify(data));}
      catch {setNotice('No se pudieron guardar los cambios en este navegador.');}
    }
  }, [data, ready]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const can = (permission: string) => !live || permissions.includes(permission);
  const command: Context['command'] = async (name, payload, key) => {
    if (!live) throw new Error('Este comando requiere el modo Supabase.');
    const result = await executeCommand(name, payload, key);
    try {await refresh();}
    catch {setLoadError('El registro se guardó, pero falta actualizar la vista. Usá Actualizar.');}
    return result;
  };
  const context: Context = {
    data, modal, notice, source: live ? 'supabase' : 'demo', can, command, refresh,
    update: fn => {
      if (live) throw new Error('Esta acción de demostración todavía no tiene una transición operativa.');
      setData(fn);
    },
    open: (kind, id) => {
      if (live && kind) {
        const permission = modalPermissions[kind];
        if (!permission) {setNotice('Esta historia todavía no está habilitada en la base operativa.'); return;}
        if (!can(permission)) {setNotice('Tu usuario no tiene permiso para esta acción.'); return;}
      }
      setModal({kind, id});
    },
    close: () => setModal({kind: null}), toast: setNotice,
    reset: () => {
      if (live) {setNotice('No se permite restaurar datos ficticios en la base operativa.'); return;}
      setData(structuredClone(seed)); setNotice('Datos de demostración restaurados.');
    },
  };
  const recoveryActions=<div className="flex flex-wrap gap-3 mt-4">
    <Button type="button" className="min-h-11" disabled={checking||recovering} onClick={()=>{void recoverSession();}}>
      {checking||recovering?'Reintentando…':'Reintentar'}
    </Button>
    <Button type="button" className="min-h-11" variant="outline" disabled={recovering} onClick={()=>{void recoverSession(true);}}>
      Volver a ingresar
    </Button>
  </div>;
  if (live && !ready) return <main className="p-8" role="status">Conectando con AJ…</main>;
  if (live && !session) return <SessionForm/>;
  if(live&&session&&workspaceUser!==session.user.id)return <main className="operations-app min-h-dvh p-6 sm:p-8">
    <section aria-label="Recuperar la sesión operativa" aria-busy={checking||recovering} className="mx-auto max-w-xl rounded-lg border bg-white p-6">
      {loadError?<><h1 className="text-xl font-semibold mb-3">No se pudo abrir el espacio de trabajo</h1>
        <p className="form-error" role="alert">{loadError}</p>{recoveryActions}</>:
        <p role="status">Cargando el espacio de trabajo…</p>}
    </section></main>;
  return <C.Provider value={context}>
    {loadError&&<section className="operations-app p-4" aria-label="Recuperar la sesión operativa">
      <p className="form-error" role="alert">{loadError}</p>{recoveryActions}</section>}
    {children}
  </C.Provider>;
}

export function useBusiness(): Context {
  const context = useContext(C);
  if (!context) throw new Error('BusinessProvider requerido');
  return context;
}

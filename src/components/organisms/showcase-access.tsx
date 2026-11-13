'use client';
import {useRef,useState} from 'react';
import {ArrowRight,LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';
import {isShowcase} from '@/lib/showcase';
import styles from './session-form.module.css';

export function ShowcaseAccess(){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const sending=useRef(false);
  if(!isShowcase)return null;
  return <section className={styles.form} aria-label="Acceso al sistema">
    <Button className={styles.submit} type="button" disabled={busy} onClick={()=>{if(sending.current)return;sending.current=true;setBusy(true);setError('');
      void (async()=>{try{
        const response=await fetch('http://127.0.0.1:56321/showcase/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});
        if(!response.ok)throw new Error('ACCESS_UNAVAILABLE');const session=await response.json();
        if(typeof session.access_token!=='string'||typeof session.refresh_token!=='string')throw new Error('INVALID_SESSION');
        const {error}=await createSupabaseBrowserClient().auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token});
        if(error)throw error;
      }catch{setError('No se pudo iniciar sesión. Revise la conexión y reintente.');}
      finally{sending.current=false;setBusy(false);}})();
    }}>{busy?<><LoaderCircle size={17} className={styles.spinner}/>Ingresando…</>:<>Ingresar<ArrowRight size={17}/></>}</Button>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </section>;
}

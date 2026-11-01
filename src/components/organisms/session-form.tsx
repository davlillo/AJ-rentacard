'use client';
import {useRef,useState} from 'react';
import {ArrowRight,CarFront,Eye,EyeOff,LoaderCircle,LockKeyhole,Mail,ShieldCheck,Wrench} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';
import styles from './session-form.module.css';

export function SessionForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visible,setVisible] = useState(false);
  const sending=useRef(false);
  return <main className={styles.page}>
    <section className={styles.showcase} aria-label="AJ Rent a Car">
      <div className={styles.brand}>
        <img src="/aj-icon.svg" width="52" height="52" alt="AJ"/>
        <div><strong>RENT A CAR</strong><span>RENTAS · TALLER · CONTROL</span></div>
      </div>
      <div className={styles.editorial}>
        <p className={styles.eyebrow}><span/> EL CONTROL TE MUEVE</p>
        <h2>Tu negocio.<br/><em>A toda marcha.</em></h2>
        <p className={styles.caption}>Cada vehículo, cada reserva, cada detalle.<br/>Toda la operación de AJ, en un solo lugar.</p>
      </div>
      <div className={styles.stage} aria-hidden="true">
        <span className={styles.watermark}>AJ</span>
        <div className={styles.track}/>
        <img src="/images/aj-red-suv.png" width="1536" height="1024" alt="" fetchPriority="high"/>
        <span className={styles.imageCaption}>PRECISIÓN EN CADA MOVIMIENTO <i/></span>
      </div>
      <div className={styles.showcaseFooter}>
        <span><CarFront size={17}/>Renta de vehículos</span>
        <span><Wrench size={16}/>Gestión de taller</span>
        <span className={styles.location}>EL SALVADOR</span>
      </div>
    </section>
    <section className={styles.access} aria-labelledby="aj-login-title">
      <div className={styles.portal}><span/> PORTAL DEL EQUIPO <span className={styles.portalLine}/></div>
      <div className={styles.formArea}>
        <div className={styles.accessIcon}><LockKeyhole size={23} strokeWidth={1.7}/></div>
        <p className={styles.formEyebrow}>BIENVENIDO A AJ</p>
        <h1 id="aj-login-title">Ingresar al sistema</h1>
        <p className={styles.description} id="aj-login-description">Su próximo movimiento comienza aquí.<br/>Acceda con su cuenta de trabajo.</p>
        <form className={styles.form} aria-describedby="aj-login-description" aria-busy={busy} onSubmit={async event => {
        event.preventDefault();
        if(sending.current)return;
        sending.current=true;
        const fields = new FormData(event.currentTarget);
        setBusy(true); setError('');
        try {
          const {error} = await createSupabaseBrowserClient().auth.signInWithPassword({
            email: String(fields.get('email')), password: String(fields.get('password')),
          });
          if (error) setError('No se pudo iniciar sesión. Revise sus credenciales y la conexión.');
        } catch {setError('No se pudo conectar con Supabase.');}
        finally {sending.current=false;setBusy(false);}
      }}>
          <fieldset disabled={busy}>
            <label htmlFor="aj-login-email">Correo electrónico</label>
            <div className={styles.inputWrap}><Mail size={18} aria-hidden="true"/>
              <input id="aj-login-email" name="email" type="email" autoComplete="username" required
                placeholder="nombre@empresa.com" spellCheck={false} autoCapitalize="none"
                aria-invalid={!!error} aria-describedby={error?'aj-login-error':undefined}/>
            </div>
            <label htmlFor="aj-login-password">Contraseña</label>
            <div className={styles.inputWrap}><LockKeyhole size={18} aria-hidden="true"/>
              <input id="aj-login-password" name="password" type={visible?'text':'password'} autoComplete="current-password" required
                placeholder="Ingrese su contraseña" aria-invalid={!!error} aria-describedby={error?'aj-login-error':undefined}/>
              <button className={styles.visibility} type="button" onClick={()=>setVisible(previous=>!previous)}
                aria-label={visible?'Ocultar contraseña':'Mostrar contraseña'} aria-pressed={visible}>
                {visible?<EyeOff size={19}/>:<Eye size={19}/>}</button>
            </div>
            {error && <p id="aj-login-error" className={styles.error} role="alert">{error}</p>}
            <Button className={styles.submit} type="submit" disabled={busy}>
              {busy?<><LoaderCircle size={18} className={styles.spinner} aria-hidden="true"/>Ingresando…</>:<>Ingresar<ArrowRight size={18} aria-hidden="true"/></>}
            </Button>
          </fieldset>
        </form>
        <p className={styles.help}>¿Necesita una cuenta o recuperar su acceso?<br/><strong>Comuníquese con la administración de AJ.</strong></p>
      </div>
      <footer className={styles.accessFooter}><ShieldCheck size={16} aria-hidden="true"/>
        <span>Acceso exclusivo para personal autorizado.</span>
      </footer>
    </section>
  </main>;
}

'use client';
import {useId,useState,type ReactNode} from 'react';
import {ChevronDown} from 'lucide-react';
import styles from './disclosure.module.css';

// One finished disclosure for the folio surfaces: a real button row with a chevron,
// never the default bold arrow of the native disclosure element. It is uncontrolled
// by default and accepts `open` when a caller needs to drive it (for example, from a link).
export function Disclosure({label,hint,children,open,defaultOpen=false,onOpenChange,className}:{
  label:ReactNode;hint?:ReactNode;children:ReactNode;open?:boolean;defaultOpen?:boolean;
  onOpenChange?:(open:boolean)=>void;className?:string;
}){
  const buttonId=useId();const panelId=useId();
  const controlled=open!==undefined;
  const [uncontrolled,setUncontrolled]=useState(defaultOpen);
  const expanded=controlled?open:uncontrolled;
  function toggle(){
    const next=!expanded;
    if(!controlled)setUncontrolled(next);
    onOpenChange?.(next);
  }
  return <div className={className?`${styles.disclosure} ${className}`:styles.disclosure}>
    <button type="button" id={buttonId} className={styles.trigger} aria-expanded={expanded}
      aria-controls={panelId} onClick={toggle}>
      <span className={styles.text}><span className={styles.label}>{label}</span>
        {hint&&<span className={styles.hint}>{hint}</span>}</span>
      <ChevronDown size={18} className={styles.chevron} aria-hidden="true"/>
    </button>
    <div id={panelId} role="region" aria-labelledby={buttonId} className={styles.panel} hidden={!expanded}>
      {children}
    </div>
  </div>;
}

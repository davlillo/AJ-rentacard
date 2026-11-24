'use client';
import {useEffect,useRef,useState} from 'react';
import {init,use,type EChartsType} from 'echarts/core';
import {BarChart,PieChart} from 'echarts/charts';
import {AriaComponent,GridComponent,TooltipComponent} from 'echarts/components';
import {SVGRenderer} from 'echarts/renderers';
import type {EChartsOption} from 'echarts';

use([BarChart,PieChart,AriaComponent,GridComponent,TooltipComponent,SVGRenderer]);

export function DashboardChart({option,label,onSelect}:{
  option:EChartsOption;label:string;onSelect?:(name:string)=>void;
}){
  const host=useRef<HTMLDivElement>(null);
  const instance=useRef<EChartsType|null>(null);
  const select=useRef(onSelect);
  const [failed,setFailed]=useState(false);
  const [attempt,setAttempt]=useState(0);
  select.current=onSelect;

  useEffect(()=>{
    if(!host.current)return;
    let observer:ResizeObserver|undefined;
    let chart:EChartsType|undefined;
    try{
      chart=init(host.current,undefined,{renderer:'svg'});
      instance.current=chart;
      chart.on('click',event=>{if(typeof event.name==='string')select.current?.(event.name);});
      observer=new ResizeObserver(()=>{if(chart&&!chart.isDisposed())chart.resize();});
      observer.observe(host.current);
    }catch{setFailed(true);}
    return()=>{observer?.disconnect();chart?.dispose();instance.current=null;};
  },[attempt]);

  useEffect(()=>{
    const chart=instance.current;
    if(!chart)return;
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>{
      try{
        chart.setOption({...option,animation:!motion.matches,animationDuration:250,animationDurationUpdate:200,
          aria:{enabled:true,label:{description:label}}},{notMerge:true});
      }catch{setFailed(true);}
    };
    update();motion.addEventListener('change',update);
    return()=>motion.removeEventListener('change',update);
  },[option,label,attempt]);

  return <div style={{height:'100%',width:'100%',minWidth:0,position:'relative'}}>
    <div ref={host} role="img" aria-label={label} data-chart="apache-echarts"
      style={{width:'100%',height:'100%',visibility:failed?'hidden':undefined}}/>
    {failed&&<div role="alert" style={{position:'absolute',inset:0,display:'grid',placeContent:'center',gap:12,padding:20}}>
      <p>No se pudo dibujar la gráfica. Los valores siguen disponibles en el detalle.</p>
      <button type="button" onClick={()=>{setFailed(false);setAttempt(value=>value+1);}}>Reintentar gráfica</button>
    </div>}
  </div>;
}

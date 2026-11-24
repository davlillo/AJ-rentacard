import type {EChartsOption} from 'echarts';
import type {CashPoint,FleetGroup} from '@/controladores/dashboard';
import {money} from '@/controladores/finanzas';

export const dashboardColors={blue:'#2563eb',orange:'#ea580c',teal:'#0d9488',amber:'#d99716',
  purple:'#7c5ac7',slate:'#718096',ink:'#24344e',muted:'#64748b',grid:'#edf0f5'};
export const fleetLabels:Record<FleetGroup,string>={Disponible:'Disponibles',Alquilado:'Alquilados',
  Reservado:'Reservados','En taller':'En taller','No disponible':'Bloqueados / por revisar'};
export const fleetColors:Record<FleetGroup,string>={Disponible:dashboardColors.teal,Alquilado:dashboardColors.blue,
  Reservado:dashboardColors.amber,'En taller':dashboardColors.purple,'No disponible':dashboardColors.slate};

const base:EChartsOption={textStyle:{fontFamily:'Manrope, sans-serif',color:dashboardColors.muted},
  tooltip:{renderMode:'richText',confine:true,backgroundColor:'#fff',borderColor:'#dfe6ef',padding:12,
    textStyle:{color:dashboardColors.ink,fontSize:12}},animationDuration:250};
const dayLabel=(day:string)=>day.slice(8,10)+'/'+day.slice(5,7);

export function cashChartOption(points:CashPoint[]):EChartsOption{
  return{...base,grid:{left:8,right:12,top:18,bottom:8,outerBoundsMode:'same',outerBoundsContain:'axisLabel'},
    tooltip:{...base.tooltip,trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:value=>money(Number(value))},
    xAxis:{type:'category',data:points.map(point=>point.from===point.to?dayLabel(point.from):
      `${dayLabel(point.from)}–${dayLabel(point.to)}`),axisTick:{show:false},axisLine:{show:false},
      axisLabel:{color:dashboardColors.muted,fontSize:11,hideOverlap:true,margin:14}},
    yAxis:{type:'value',axisLabel:{formatter:value=>'$'+new Intl.NumberFormat('en-US',
      {notation:'compact',maximumFractionDigits:1}).format(value),fontSize:11},
      splitLine:{lineStyle:{color:dashboardColors.grid,type:'dashed'}}},
    series:[{name:'Entradas',type:'bar',data:points.map(point=>point.inflow),barMaxWidth:17,
      itemStyle:{color:dashboardColors.blue,borderRadius:[4,4,0,0]},emphasis:{focus:'series'}},
    {name:'Salidas',type:'bar',data:points.map(point=>point.outflow),barMaxWidth:17,
      itemStyle:{color:dashboardColors.orange,borderRadius:[4,4,0,0]},emphasis:{focus:'series'}}]};
}

export function fleetChartOption(groups:{name:FleetGroup;vehicles:unknown[]}[]):EChartsOption{
  return{...base,tooltip:{...base.tooltip,trigger:'item',formatter:'{b}: {c} vehículos ({d}%)'},
    series:[{name:'Flota de alquiler',type:'pie',radius:['69%','89%'],center:['50%','50%'],
      label:{show:false},labelLine:{show:false},stillShowZeroSum:false,
      itemStyle:{borderColor:'#fff',borderWidth:4,borderRadius:6},
      emphasis:{scaleSize:5},data:groups.map(group=>({name:fleetLabels[group.name],value:group.vehicles.length,
        itemStyle:{color:fleetColors[group.name]}}))}]};
}

export function workshopChartOption(stages:{name:string;count:number}[]):EChartsOption{
  return{...base,grid:{left:0,right:30,top:8,bottom:8,outerBoundsMode:'same',outerBoundsContain:'axisLabel'},
    tooltip:{...base.tooltip,trigger:'item',formatter:'{b}: {c} trabajos'},
    xAxis:{type:'value',minInterval:1,splitLine:{show:false},show:false},
    yAxis:{type:'category',inverse:true,data:stages.map(stage=>stage.name==='Control de calidad'?'Control de\ncalidad':stage.name),
      axisLine:{show:false},axisTick:{show:false},axisLabel:{fontSize:12,lineHeight:17,color:dashboardColors.ink}},
    series:[{type:'bar',name:'Trabajos recibidos',barWidth:23,showBackground:true,
      backgroundStyle:{color:'#f3f5f9',borderRadius:5},label:{show:true,position:'right',color:dashboardColors.ink,fontWeight:700},
      data:stages.map((stage,index)=>({name:stage.name,value:stage.count,
        itemStyle:{color:[dashboardColors.amber,dashboardColors.blue,dashboardColors.teal][index],borderRadius:5}}))}]};
}

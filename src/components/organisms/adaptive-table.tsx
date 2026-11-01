'use client';
import {Children,cloneElement,isValidElement,type ReactNode,type TableHTMLAttributes} from 'react';

type CellProps={children?:ReactNode;colSpan?:number;'data-label'?:string;role?:string;};
function plainText(node:ReactNode):string{
  return Children.toArray(node).map(child=>typeof child==='string'||typeof child==='number'?String(child):
    isValidElement<CellProps>(child)?plainText(child.props.children):'').join('');
}

// Keep one semantic table. Mobile cells carry their own headings rather than hiding columns or scrolling.
export function AdaptiveTable({children,className='',...props}:TableHTMLAttributes<HTMLTableElement>){
  const sections=Children.toArray(children);let labels:string[]=[];
  for(const section of sections)if(isValidElement<CellProps>(section)&&section.type==='thead'){
    const row=Children.toArray(section.props.children).find(isValidElement<CellProps>);
    if(row)labels=Children.toArray(row.props.children).map(cell=>isValidElement<CellProps>(cell)?plainText(cell.props.children):'');
  }
  const content=sections.map(section=>{
    if(!isValidElement<CellProps>(section)||section.type!=='tbody')return section;
    return cloneElement(section,{role:'rowgroup'},Children.map(section.props.children,row=>{
      if(!isValidElement<CellProps>(row))return row;
      return cloneElement(row,{role:'row'},Children.map(row.props.children,(cell,index)=>{
        if(!isValidElement<CellProps>(cell))return cell;
        return cloneElement(cell,{'data-label':cell.props.colSpan?undefined:labels[index],role:'cell'});
      }));
    }));
  });
  return <table {...props} role="table" className={`adaptive-table ${labels.length>6?'adaptive-table-wide ':''}${className}`}>{content}</table>;
}

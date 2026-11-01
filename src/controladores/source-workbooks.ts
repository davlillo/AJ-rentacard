import * as XLSX from 'xlsx';
import {checkArchive,IMPORT_LIMITS} from './import-workbook';

export type WorkbookFormat='diary'|'budget'|'fleet'|'receivables'|'unknown';
export interface OriginalCell {address:string;value:string|number;display:string;formula?:string;date?:string;fill?:string;}
export interface OriginalSheet {name:string;range:string;rows:{number:number;cells:OriginalCell[]}[];merges:{start:string;end:string}[];}
export interface WorkbookCandidate {
  sourceRef:string;sheet:string;row:number;category:string;title:string;description:string;
  date:string|null;amounts:{cell:string;amount:number}[];warnings:string[];facts:Record<string,string|boolean>;
}
export interface SourceWorkbook {fileName:string;base64:string;format:WorkbookFormat;sheets:OriginalSheet[];items:WorkbookCandidate[];parserVersion:string;}
const normalized=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const monthNames=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function fullDate(text:string):string|null{
  const match=normalized(text).match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(20\d{2})\b/);
  if(!match)return null;const month=monthNames.indexOf(match[2]);if(month<0)return null;
  const value=`${match[3]}-${String(month+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  const parsed=new Date(value+'T00:00:00Z');return Number.isNaN(parsed.getTime())?null:parsed.toISOString().slice(0,10)===value?value:null;
}
function detectFormat(fileName:string,sheets:OriginalSheet[]):WorkbookFormat{
  const text=normalized(fileName+' '+sheets.flatMap(s=>s.rows.slice(0,5).flatMap(r=>r.cells.map(c=>c.display))).join(' '));
  if(/calendario|reservas actuales/.test(text))return 'fleet';
  if(/presupuesto/.test(text))return 'budget';
  if(/cuentas por cobrar/.test(text))return 'receivables';
  if(/libro diario/.test(text))return 'diary';return 'unknown';
}

// Source workbooks are not tabular expense imports. Preserve row one and cell
// coordinates, styles and cached formula values; never execute Excel formulas.
export function parseSourceWorkbook(fileName:string,buffer:ArrayBuffer):SourceWorkbook{
  if(!/\.xlsx$/i.test(fileName)||buffer.byteLength<1||buffer.byteLength>IMPORT_LIMITS.bytes)throw new Error('Seleccione un XLSX de hasta 5 MB.');
  const bytes=new Uint8Array(buffer);checkArchive(bytes);
  const book=XLSX.read(bytes,{type:'array',cellDates:false,cellFormula:true,cellNF:true,cellStyles:true,sheetRows:2001});
  if(book.SheetNames.length>20)throw new Error('Se admiten hasta 20 hojas.');
  let nonempty=0;
  const sheets=book.SheetNames.map((name):OriginalSheet=>{
    const sheet=book.Sheets[name];const ref=sheet['!fullref']??sheet['!ref']??'A1';const range=XLSX.utils.decode_range(ref);
    if(range.e.r>=2000||range.e.c>=50)throw new Error('La consulta de originales admite hasta 2000 filas y 50 columnas por hoja.');
    const rows:OriginalSheet['rows']=[];
    for(let r=range.s.r;r<=range.e.r;r++){
      const cells:OriginalCell[]=[];
      for(let c=range.s.c;c<=range.e.c;c++){
        const address=XLSX.utils.encode_cell({r,c});const cell=sheet[address];if(cell?.v===undefined&&!cell?.f)continue;
        if(++nonempty>20000)throw new Error('El libro excede 20000 celdas no vacías.');
        const raw=cell?.v??'';if(String(raw).length>10000||String(cell?.f??'').length>10000)throw new Error('Una celda supera el límite de texto.');
        const calendar=cell?.t==='n'&&XLSX.SSF.is_date(cell.z??'')?XLSX.SSF.parse_date_code(raw,{date1904:book.Workbook?.WBProps?.date1904}):null;
        const date=calendar?`${calendar.y}-${String(calendar.m).padStart(2,'0')}-${String(calendar.d).padStart(2,'0')}`:undefined;
        const rgb=(cell.s as {fgColor?:{rgb?:string}}|undefined)?.fgColor?.rgb;
        cells.push({address,value:typeof raw==='number'&&Number.isFinite(raw)?raw:String(raw),
          display:String(cell.w??date??raw),...(cell.f?{formula:cell.f}:{}),...(date?{date}:{}),
          ...(rgb&&/^[A-Fa-f0-9]{6}$/.test(rgb)?{fill:rgb}:{})});
      }
      if(cells.length)rows.push({number:r+1,cells});
    }
    return{name,range:ref,rows,merges:(sheet['!merges']??[]).map(m=>({start:XLSX.utils.encode_cell(m.s),end:XLSX.utils.encode_cell(m.e)}))};
  });
  const format=detectFormat(fileName,sheets);const items=adaptSourceSheets(format,sheets);
  let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return{fileName,base64:btoa(binary),format,sheets,items,parserVersion:'aj-workbook-review-v1'};
}

export function adaptSourceSheets(format:WorkbookFormat,sheets:OriginalSheet[]):WorkbookCandidate[]{
  const result:WorkbookCandidate[]=[];
  for(const sheet of sheets){
    let date:string|null=null;let group='';let actualCosts=false;
    for(const row of sheet.rows){
      const at=(col:string)=>row.cells.find(c=>c.address===col+row.number);
      const text=(col:string)=>String(at(col)?.value??'').trim();
      const rowText=row.cells.map(c=>c.display).join(' · ');const lower=normalized(rowText);
      const amounts=row.cells.filter(c=>typeof c.value==='number'&&!c.date).map(c=>({cell:c.address,amount:Number(c.value)}));
      const emit=(category:string,title:string,facts:WorkbookCandidate['facts']={},warnings:string[]=[],columns?:string[])=>{
        const cells=columns?row.cells.filter(c=>columns.some(col=>c.address===col+row.number)):row.cells;
        const reference=cells.length?`${cells[0].address}:${cells[cells.length-1].address}`:`A${row.number}`;
        result.push({sourceRef:`${sheet.name}!${reference}`,sheet:sheet.name,row:row.number,category,title,
          description:cells.map(c=>`${c.address}: ${c.display}`).join(' | '),date:cells.find(c=>c.date)?.date??date,
          amounts:columns?amounts.filter(a=>columns.some(col=>a.cell===col+row.number)):amounts,
          warnings:[...warnings,...(cells.some(c=>c.formula)?['Contiene fórmula; se muestra el valor guardado, sin recalcular.']:[])],facts});
      };
      if(format==='diary'){
        const header=fullDate(text('C'));if(header){date=header;continue;}
        if(/sumas|total pasa|total egreso|total ingreso|\bviene\b|\bpasa\b|libro diario mes/.test(lower)){
          emit('Control','Saldo, subtotal o encabezado',{},['No es un movimiento; no publicar como gasto ni cobro.']);continue;
        }
        if(!text('C'))continue;
        const warning=['Revisar el tipo financiero: el importe o la columna no determina si es ingreso, gasto o remesa.'];
        if(!date)warning.push('Falta fecha completa de encabezado.');
        emit('Diario',text('C'),{},warning,['B','C','D','E','F','G','H','I']);
      }else if(format==='fleet'){
        if(normalized(text('B')).startsWith('linea ')){group=text('B');continue;}
        if(!text('D')||normalized(text('D'))==='vehiculo')continue;
        const warnings=['La pertenencia a flota requiere confirmación; titular registral no equivale a propietario de AJ.'];
        if(!text('C'))warnings.push('Sin placa: posible continuación o duplicado. No crear vehículo automáticamente.');
        if(/cancelado hasta/.test(lower))warnings.push('Cancelado hasta significa pagado hasta; no cancelar la reserva ni registrar un recibo desde esta nota.');
        warnings.push('Las fechas escritas sin año y las identidades deben resolverse antes de crear alquileres.');
        emit('Flota',`${text('C')||'Sin placa'} · ${text('D')}`,{plate:text('C'),registeredHolder:text('B'),commercialLine:group,
          currentRental:text('F'),customerText:text('H'),pendingText:text('I'),openEnded:/sin definir/.test(lower)},warnings);
      }else if(format==='budget'){
        if(/costos libro diario/.test(lower)){actualCosts=true;continue;}
        if(/total|presupuesto inicial|adicionales|\bsaldo\b/.test(lower)&&amounts.length){
          emit('Control','Resumen del presupuesto',{},['Total manual o saldo: conciliar, no convertir en otro movimiento.']);continue;
        }
        if(actualCosts){
          if(!text('B'))continue;
          const isPayment=/\babono\b/.test(normalized(text('B')));
          emit(isPayment?'Abono por revisar':'Costo por revisar',text('B'),{},[
            isPayment?'Es un abono dentro de una sección de costos: no es un gasto.':'Una compra pagada y su comprobante son un solo costo; revisar duplicados del diario.',
            'Las fechas son las de la celda original, no las de los otros libros.']);
        }else{
          if(text('B')&&typeof at('C')?.value==='number')emit('Partida',text('B'),{},['Distinguir costo previsto y precio comercial; confirmar columnas.'],['B','C']);
          if(text('E')&&typeof at('F')?.value==='number')emit('Partida',text('E'),{},['La mano de obra y materiales internos no son automáticamente un pago o cargo.'],['E','F','H','I']);
        }
      }else if(format==='receivables'){
        if(!amounts.length&&!text('B'))continue;
        const control=/^total/.test(normalized(text('A')))||/^suma/.test(normalized(text('B')));
        emit(control?'Control':'Cartera',text('B')||text('A')||'Documento o saldo por revisar',{},[
          control?'Subtotal: no publicar como deuda.':'Confirmar cliente, documento y períodos. Un saldo escrito no prueba un cobro.',
          'Los documentos pueden incluir varios vehículos y deducciones GPS; no duplicar el total por cada placa.']);
      }else emit('Sin formato reconocido',rowText.slice(0,200),{},['Seleccione revisión manual; no se interpreta como tabla de gastos.']);
    }
  }
  return result;
}

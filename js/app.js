// SiteShrimp v2 — Multi-tenant Construction Site Tracker
// Features: Auth, Companies, Projects, Roles, AI, Telegram, Email
// Constants loaded from js/constants.js (SEVERITY, STATUS, ROLES, ENTRY_TYPES, etc.)
const {useState,useEffect,useRef,useCallback,useMemo}=React;

// ── Local Storage ─────────────────────────────────────────────────
const local={
  get:(k)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch{return null;}},
  set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}},
  del:(k)=>{try{localStorage.removeItem(k);}catch{}}
};

// ── Utilities ─────────────────────────────────────────────────────
// Sanitize user input for safe HTML embedding (Telegram, email reports)
function sanitize(str){return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

function compressPhoto(dataUrl,maxPx=1800,quality=0.8){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      let w=img.width,h=img.height;
      if(w>maxPx){h=Math.round(h*maxPx/w);w=maxPx;}
      if(h>maxPx){w=Math.round(w*maxPx/h);h=maxPx;}
      const c=document.createElement("canvas");
      c.width=w;c.height=h;
      c.getContext("2d").drawImage(img,0,0,w,h);
      resolve(c.toDataURL("image/jpeg",quality));
    };
    img.onerror=()=>resolve(null);
    img.src=dataUrl;
  });
}

const DRAWING_NOTES_KEY="drawing_notes_v1";
const DRAWING_MARKUP_KEY="drawing_markup_v1";
const SAVED_COMPARISONS_KEY="saved_comparisons_v1";
const BCA_SCDF_REVISION_COLORS={added:"#ff00ff",removed:"#ddcc00",existing:"#00cccc"};
const fileTimestamp=()=>{const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}_${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;};

function getSavedComparisons(projectId){
  const all=local.get(SAVED_COMPARISONS_KEY)||{};
  return Array.isArray(all[projectId])?all[projectId]:[];
}
function setSavedComparisons(projectId,list){
  const all=local.get(SAVED_COMPARISONS_KEY)||{};
  all[projectId]=list;
  local.set(SAVED_COMPARISONS_KEY,all);
}

function loadDrawingNotesMap(){
  const raw=local.get(DRAWING_NOTES_KEY);
  return raw&&typeof raw==="object"?raw:{};
}

function getDrawingNotes(drawingId){
  const map=loadDrawingNotesMap();
  return Array.isArray(map[drawingId])?map[drawingId]:[];
}

function saveDrawingNotes(drawingId,notes){
  const map=loadDrawingNotesMap();
  map[drawingId]=notes;
  local.set(DRAWING_NOTES_KEY,map);
}

function getDrawingMarkup(drawingId){
  const map=local.get(DRAWING_MARKUP_KEY)||{};
  return Array.isArray(map[drawingId])?map[drawingId]:[];
}

function saveDrawingMarkup(drawingId,strokes){
  const map=local.get(DRAWING_MARKUP_KEY)||{};
  map[drawingId]=strokes;
  local.set(DRAWING_MARKUP_KEY,map);
}

function normalizePdfLine(text){
  return String(text||"")
    .replace(/\s+/g," ")
    .replace(/[•·]/g," ")
    .trim()
    .toUpperCase();
}

async function extractPdfLines(url,maxPages=30){
  if(!window.pdfjsLib)throw new Error("PDF comparison engine not available");
  const pdfjsLib=window.pdfjsLib;
  if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const doc=await pdfjsLib.getDocument(url).promise;
  try{
    const pageLimit=Math.min(doc.numPages,maxPages);
    const lines=[];
    for(let pageNum=1;pageNum<=pageLimit;pageNum++){
      const page=await doc.getPage(pageNum);
      const vp=page.getViewport({scale:1});
      const pw=vp.width,ph=vp.height;
      const content=await page.getTextContent();
      const rows=new Map();
      (content.items||[]).forEach(it=>{
        const txt=(it.str||"").trim();
        if(!txt)return;
        const y=Math.round((it.transform?.[5]||0)/2)*2;
        const x=it.transform?.[4]||0;
        if(!rows.has(y))rows.set(y,[]);
        rows.get(y).push({x,txt});
      });
      [...rows.entries()].sort((a,b)=>b[0]-a[0]).forEach(([rawY,items])=>{
        const line=normalizePdfLine(items.sort((a,b)=>a.x-b.x).map(i=>i.txt).join(" "));
        if(line.length>2){
          const minX=Math.min(...items.map(i=>i.x));
          const maxX=Math.max(...items.map(i=>i.x));
          // Convert to percentage of page (PDF Y is bottom-up)
          lines.push({text:`P${pageNum} ${line}`,xPct:pw?(minX/pw)*100:0,yPct:ph?((ph-rawY)/ph)*100:0,wPct:pw?((maxX-minX)/pw)*100:10,pageNum});
        }
      });
    }
    return lines;
  }finally{
    try{await doc.destroy();}catch{}
  }
}

function comparePdfLineSets(baseLines,revisionLines){
  const baseSet=new Set(baseLines.map(l=>l.text||l));
  const revisionSet=new Set(revisionLines.map(l=>l.text||l));
  const added=revisionLines.filter(l=>!baseSet.has(l.text||l));
  const removed=baseLines.filter(l=>!revisionSet.has(l.text||l));
  return{added,removed};
}

// ── Annotated drawing rendering (for PDF exports) ────────────────
// Renders each relevant page of a drawing (PDF or image) to a canvas
// with pins, notes and markup strokes burned in, and returns an array
// of { pageNum, dataUrl } suitable for embedding as <img> in a report.
function _loadImageEl(url){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(new Error("Image load failed"));
    img.src=url;
  });
}
function _roundRectPath(ctx,x,y,w,h,r){
  const rr=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y,x+w,y+h,rr);
  ctx.arcTo(x+w,y+h,x,y+h,rr);
  ctx.arcTo(x,y+h,x,y,rr);
  ctx.arcTo(x,y,x+w,y,rr);
  ctx.closePath();
}
async function _preloadStrokePhotos(strokes){
  const cache={};
  const photos=(strokes||[]).filter(s=>s&&s.type==="photo"&&s.dataUrl);
  await Promise.all(photos.map(s=>new Promise(resolve=>{
    if(cache[s.dataUrl])return resolve();
    const img=new Image();
    img.onload=()=>{cache[s.dataUrl]=img;resolve();};
    img.onerror=()=>resolve();
    img.src=s.dataUrl;
  })));
  return cache;
}
function _drawMarkupStroke(ctx,W,H,s,imageCache){
  const px=p=>({x:(p.x/100)*W,y:(p.y/100)*H});
  ctx.save();
  ctx.strokeStyle=s.color||"#ff6b00";
  ctx.fillStyle=s.color||"#ff6b00";
  ctx.lineWidth=Math.max(2,W*0.003);
  ctx.lineCap="round";ctx.lineJoin="round";
  if(s.type==="freehand"&&Array.isArray(s.points)&&s.points.length>1){
    ctx.beginPath();
    const p0=px(s.points[0]);ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<s.points.length;i++){const p=px(s.points[i]);ctx.lineTo(p.x,p.y);}
    ctx.stroke();
  }else if(s.type==="arrow"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    ctx.setLineDash([]);
    const angle=Math.atan2(b.y-a.y,b.x-a.x);
    const hl=Math.max(12,W*0.018);
    ctx.beginPath();
    ctx.moveTo(b.x,b.y);
    ctx.lineTo(b.x-hl*Math.cos(angle-0.4),b.y-hl*Math.sin(angle-0.4));
    ctx.moveTo(b.x,b.y);
    ctx.lineTo(b.x-hl*Math.cos(angle+0.4),b.y-hl*Math.sin(angle+0.4));
    ctx.stroke();
  }else if(s.type==="circle"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    const cx=(a.x+b.x)/2,cy=(a.y+b.y)/2;
    const rx=Math.abs(b.x-a.x)/2,ry=Math.abs(b.y-a.y)/2;
    if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
    if(rx>1||ry>1){ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.stroke();}
    ctx.setLineDash([]);
  }else if(s.type==="rect"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
    if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
    if(w>1||h>1){ctx.beginPath();ctx.rect(x,y,w,h);ctx.stroke();}
    ctx.setLineDash([]);
  }else if(s.type==="line"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    ctx.setLineDash([]);
  }else if(s.type==="dimension"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.sqrt(dx*dx+dy*dy);
    if(len>3){
      const tick=Math.max(8,W*0.012);
      const nx=(-dy/len)*tick,ny=(dx/len)*tick;
      if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(a.x+nx,a.y+ny);ctx.lineTo(a.x-nx,a.y-ny);ctx.stroke();
      ctx.beginPath();ctx.moveTo(b.x+nx,b.y+ny);ctx.lineTo(b.x-nx,b.y-ny);ctx.stroke();
      const label=s.label||"";
      if(label){
        const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
        const fs=Math.max(10,W*0.014);
        ctx.save();
        ctx.translate(mx,my);
        const angle=Math.atan2(dy,dx);
        ctx.rotate(angle>Math.PI/2||angle<-Math.PI/2?angle+Math.PI:angle);
        ctx.font=`bold ${fs}px 'Barlow Condensed',sans-serif`;
        ctx.textAlign="center";ctx.textBaseline="bottom";
        ctx.fillText(label,0,-4);
        ctx.restore();
      }
    }
  }else if(s.type==="text"&&s.pos&&s.text){
    const p=px(s.pos);
    const fs=(s.fontSize?Math.max(8,W*s.fontSize*0.0075):Math.max(14,W*0.018));
    ctx.font=`bold ${fs}px Arial`;
    const tw=ctx.measureText(s.text).width;
    // Tight padding — minimal so valign actually shifts the text visibly
    const padX=fs*0.15,padY=fs*0.08;
    const align=s.align||"left";
    const valign=s.valign||"bottom";
    const bw=tw+padX*2,bh=fs+padY*2;
    let bgX;
    if(align==="center")bgX=p.x-bw/2;
    else if(align==="right")bgX=p.x-bw;
    else bgX=p.x;
    let bgY;
    if(valign==="top")bgY=p.y;
    else if(valign==="middle")bgY=p.y-bh/2;
    else bgY=p.y-bh;
    const textX=align==="center"?p.x:(align==="right"?p.x-padX:p.x+padX);
    const textY=bgY+fs+padY*0.85;
    ctx.fillStyle="rgba(255,255,255,0.92)";
    ctx.strokeStyle=s.color||"#ff6b00";
    ctx.lineWidth=2;
    _roundRectPath(ctx,bgX,bgY,bw,bh,4);
    ctx.fill();ctx.stroke();
    ctx.fillStyle=s.color||"#ff6b00";
    ctx.textBaseline="alphabetic";
    ctx.textAlign=align==="center"?"center":(align==="right"?"right":"left");
    ctx.fillText(s.text,textX,textY);
    ctx.textAlign="left";
  }else if(s.type==="cloud"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
    if(w>2||h>2){
      ctx.beginPath();
      const arcsPerW=Math.max(4,Math.round(w/18)),arcsPerH=Math.max(4,Math.round(h/18));
      const dw=w/arcsPerW,dh=h/arcsPerH,r=Math.max(dw,dh)*0.55;
      for(let i=0;i<arcsPerW;i++){const cx=x+dw*i+dw/2;ctx.arc(cx,y,r,Math.PI,0);}
      for(let i=0;i<arcsPerH;i++){const cy=y+dh*i+dh/2;ctx.arc(x+w,cy,r,-Math.PI/2,Math.PI/2);}
      for(let i=arcsPerW-1;i>=0;i--){const cx=x+dw*i+dw/2;ctx.arc(cx,y+h,r,0,Math.PI);}
      for(let i=arcsPerH-1;i>=0;i--){const cy=y+dh*i+dh/2;ctx.arc(x,cy,r,Math.PI/2,-Math.PI/2);}
      ctx.stroke();
    }
  }else if(s.type==="callout"&&s.start&&s.end){
    const a=px(s.start),b=px(s.end);
    const angle=Math.atan2(b.y-a.y,b.x-a.x);
    const hl=Math.max(12,W*0.018);
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    ctx.beginPath();ctx.moveTo(a.x,a.y);
    ctx.lineTo(a.x+hl*Math.cos(angle-0.4),a.y+hl*Math.sin(angle-0.4));
    ctx.moveTo(a.x,a.y);
    ctx.lineTo(a.x+hl*Math.cos(angle+0.4),a.y+hl*Math.sin(angle+0.4));
    ctx.stroke();
    if(s.text){
      const fs=s.fontSize?Math.max(8,W*s.fontSize*0.0075):Math.max(12,W*0.014);
      ctx.font=`bold ${fs}px Arial`;
      const tw=ctx.measureText(s.text).width;
      const pad=fs*0.3;
      ctx.fillStyle="rgba(255,255,255,0.92)";
      ctx.strokeStyle=s.color||"#ff6b00";ctx.lineWidth=2;
      _roundRectPath(ctx,b.x-pad,b.y-fs-pad,tw+pad*2,fs+pad*2,4);
      ctx.fill();ctx.stroke();
      ctx.fillStyle=s.color||"#ff6b00";
      ctx.textBaseline="alphabetic";ctx.textAlign="left";
      ctx.fillText(s.text,b.x,b.y);
    }
  }else if(s.type==="highlight"&&Array.isArray(s.points)&&s.points.length>1){
    ctx.save();
    ctx.globalAlpha=0.3;
    ctx.lineWidth=Math.max(8,W*0.015);
    ctx.lineCap="round";ctx.lineJoin="round";
    ctx.beginPath();
    const p0=px(s.points[0]);ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<s.points.length;i++){const p=px(s.points[i]);ctx.lineTo(p.x,p.y);}
    ctx.stroke();
    ctx.restore();
  }else if(s.type==="polyline"&&Array.isArray(s.points)&&s.points.length>1){
    if(s.lineStyle==="dotted")ctx.setLineDash([Math.max(4,W*0.005),Math.max(3,W*0.004)]);
    ctx.beginPath();
    const p0=px(s.points[0]);ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<s.points.length;i++){const p=px(s.points[i]);ctx.lineTo(p.x,p.y);}
    if(s.closed)ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }else if(s.type==="stamp"&&s.pos){
    const p=px(s.pos);
    const text=s.text||s.stampId||"STAMP";
    const fs=s.fontSize?Math.max(8,W*s.fontSize*0.0075):Math.max(16,W*0.022);
    ctx.save();
    ctx.translate(p.x,p.y);ctx.rotate(-15*Math.PI/180);
    ctx.font=`bold ${fs}px Arial`;
    const tw=ctx.measureText(text).width;
    const pad=fs*0.4;
    const stampColor=s.stampId==="APPROVED"?"#34c759":s.stampId==="REJECTED"?"#ff3b30":s.stampId==="REVIEWED"?"#007aff":s.color||"#ff9500";
    ctx.strokeStyle=stampColor;ctx.lineWidth=Math.max(2,fs*0.08);
    ctx.strokeRect(-tw/2-pad,-fs/2-pad,tw+pad*2,fs+pad*2);
    ctx.fillStyle=stampColor;ctx.globalAlpha=0.85;
    ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.fillText(text,0,0);
    ctx.restore();
  }else if(s.type==="photo"&&s.pos&&s.dataUrl){
    const x=(s.pos.x/100)*W;
    const y=(s.pos.y/100)*H;
    const w=(s.w/100)*W;
    const h=(s.h/100)*H;
    const img=imageCache&&imageCache[s.dataUrl];
    if(img){
      try{ctx.drawImage(img,x,y,w,h);}catch(e){}
    }else{
      ctx.fillStyle="rgba(255,107,0,0.15)";
      ctx.fillRect(x,y,w,h);
    }
    ctx.strokeStyle="rgba(255,255,255,0.85)";
    ctx.lineWidth=Math.max(1,W*0.0015);
    ctx.strokeRect(x,y,w,h);
  }
  ctx.restore();
}
function _drawNoteMarker(ctx,W,H,n){
  const x=(n.x/100)*W,y=(n.y/100)*H;
  const fs=Math.max(12,W*0.013);
  ctx.save();
  ctx.font=`bold ${fs}px Arial`;
  const label=(n.text||"").slice(0,60);
  const tw=ctx.measureText(label).width;
  const pad=fs*0.5;
  const bw=tw+pad*2+fs*1.2,bh=fs+pad*1.2;
  ctx.fillStyle="rgba(88,86,214,0.92)";
  ctx.strokeStyle="#fff";ctx.lineWidth=Math.max(1.5,W*0.0015);
  _roundRectPath(ctx,x-bw/2,y-bh/2,bw,bh,fs*0.35);
  ctx.fill();ctx.stroke();
  ctx.fillStyle="#fff";
  ctx.textBaseline="middle";
  ctx.fillText("📝 "+label,x-bw/2+pad,y);
  ctx.restore();
}
function _drawPinMarker(ctx,W,H,pin,defect){
  const x=(pin.x/100)*W,y=(pin.y/100)*H;
  const color=defect?(SEV_COLOR[defect.severity]||"#ff6b00"):"#8e8e93";
  const r=Math.max(14,W*0.016);
  ctx.save();
  ctx.fillStyle="rgba(0,0,0,0.55)";
  ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=Math.max(3,r*0.28);
  ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=color;
  ctx.beginPath();ctx.arc(x,y,r*0.38,0,Math.PI*2);ctx.fill();
  if(defect?.severity){
    ctx.fillStyle="#fff";
    ctx.font=`900 ${Math.round(r*0.95)}px Arial`;
    ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.fillText(defect.severity[0],x,y);
  }
  ctx.restore();
}
async function renderDrawingAnnotatedPages(drawing,defects,allPins){
  if(!drawing||!drawing.file)return[];
  const fileUrl=DB.fileUrl("drawings",drawing.id,drawing.file);
  const isPdf=/\.pdf$/i.test(drawing.file||"");
  const notes=getDrawingNotes(drawing.id)||[];
  const markups=getDrawingMarkup(drawing.id)||[];
  const pins=(allPins||[]).filter(p=>p.drawingId===drawing.id);
  const pageSet=new Set();
  pins.forEach(p=>pageSet.add(p.pageNum||1));
  notes.forEach(n=>pageSet.add(n.pageNum||1));
  if(pageSet.size===0&&markups.length>0)pageSet.add(1);
  if(pageSet.size===0)return[];
  const pages=[...pageSet].sort((a,b)=>a-b);
  const imgCache=await _preloadStrokePhotos(markups);
  const applyOverlays=(ctx,W,H,pageNum)=>{
    markups.forEach(s=>_drawMarkupStroke(ctx,W,H,s,imgCache));
    notes.filter(n=>(n.pageNum||1)===pageNum).forEach(n=>_drawNoteMarker(ctx,W,H,n));
    pins.filter(p=>(p.pageNum||1)===pageNum).forEach(p=>{
      const def=(defects||[]).find(x=>x.id===p.entryId);
      _drawPinMarker(ctx,W,H,p,def);
    });
  };
  const out=[];
  if(isPdf){
    if(!window.pdfjsLib)return[];
    const pdfjsLib=window.pdfjsLib;
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    let doc=null;
    try{
      doc=await pdfjsLib.getDocument(fileUrl).promise;
      for(const pn of pages){
        if(pn>doc.numPages)continue;
        const page=await doc.getPage(pn);
        const viewport=page.getViewport({scale:1.5});
        const canvas=document.createElement("canvas");
        canvas.width=viewport.width;canvas.height=viewport.height;
        const ctx=canvas.getContext("2d");
        ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
        await page.render({canvasContext:ctx,viewport}).promise;
        applyOverlays(ctx,canvas.width,canvas.height,pn);
        out.push({pageNum:pn,dataUrl:canvas.toDataURL("image/jpeg",0.85)});
      }
    }catch(e){console.warn("renderDrawingAnnotatedPages PDF failed for",drawing.name,e);}
    finally{try{if(doc)await doc.destroy();}catch{}}
  }else{
    try{
      const img=await _loadImageEl(fileUrl);
      const maxW=1600;
      const scale=Math.min(1,maxW/(img.width||maxW));
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round((img.width||maxW)*scale));
      canvas.height=Math.max(1,Math.round((img.height||maxW)*scale));
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      applyOverlays(ctx,canvas.width,canvas.height,1);
      out.push({pageNum:1,dataUrl:canvas.toDataURL("image/jpeg",0.85)});
    }catch(e){console.warn("renderDrawingAnnotatedPages image failed for",drawing.name,e);}
  }
  return out;
}

// ── Photo Markup Editor ──────────────────────────────────────────
function PhotoMarkup({src,onSave,onCancel}){
  const canvasRef=useRef();const overlayRef=useRef();
  const[tool,setTool]=useState("arrow"); // arrow, circle, rect, line, dimension, freehand, text, cloud, callout, highlight, polyline, stamp
  const[color,setColor]=useState("#ff3b30");
  const[lineStyle,setLineStyle]=useState("solid");
  const[strokes,setStrokes]=useState([]);
  const[redoStack,setRedoStack]=useState([]);
  const[current,setCurrent]=useState(null);
  const[imgLoaded,setImgLoaded]=useState(false);
  const[textInput,setTextInput]=useState(null);
  const[polylinePoints,setPolylinePoints]=useState([]);
  const[polylineClosed,setPolylineClosed]=useState(false);
  const[stampType,setStampType]=useState("APPROVED");
  const[showStampMenu,setShowStampMenu]=useState(false);
  const[calloutTextInput,setCalloutTextInput]=useState(null);
  const imgRef=useRef(new Image());
  const sizeRef=useRef({w:0,h:0});
  const dragRef=useRef(null); // {idx, startPos, origStroke}
  const STAMP_PRESETS=["APPROVED","REJECTED","REVIEWED","HOLD","FOR CONSTRUCTION","PRELIMINARY","DRAFT","SUPERSEDED","NOT FOR CONSTRUCTION"];
  const addStroke=(s)=>{setStrokes(prev=>[...prev,s]);setRedoStack([]);};
  const undo=()=>{setStrokes(s=>{if(!s.length)return s;setRedoStack(r=>[...r,s[s.length-1]]);return s.slice(0,-1);});};
  const redo=()=>{setRedoStack(r=>{if(!r.length)return r;const item=r[r.length-1];setStrokes(s=>[...s,item]);return r.slice(0,-1);});};

  // Load image
  useEffect(()=>{
    const img=imgRef.current;
    img.onload=()=>{setImgLoaded(true);};
    img.src=src;
  },[src]);

  // Render all strokes
  useEffect(()=>{
    if(!imgLoaded||!canvasRef.current)return;
    const canvas=canvasRef.current;
    const container=canvas.parentElement;
    const cw=container.clientWidth;
    const img=imgRef.current;
    const ratio=img.height/img.width;
    const ch=Math.round(cw*ratio);
    canvas.width=cw;canvas.height=ch;
    sizeRef.current={w:cw,h:ch};
    const ctx=canvas.getContext("2d");
    ctx.drawImage(img,0,0,cw,ch);
    [...strokes,current].filter(Boolean).forEach(s=>drawStroke(ctx,s));
    // Draw polyline preview
    if(polylinePoints.length>1){
      drawStroke(ctx,{type:"polyline",color,points:polylinePoints,closed:polylineClosed,lineStyle});
    }else if(polylinePoints.length===1){
      ctx.fillStyle=color;ctx.beginPath();ctx.arc(polylinePoints[0].x,polylinePoints[0].y,4,0,Math.PI*2);ctx.fill();
    }
  },[imgLoaded,strokes,current,polylinePoints,polylineClosed]);

  const drawStroke=(ctx,s,scale=1)=>{
    const lw=3*scale;
    const fontSize=Math.round((s.textSize||16)*scale);
    const hl=14*scale;
    ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.lineWidth=lw;ctx.lineCap="round";ctx.lineJoin="round";
    if(s.type==="freehand"&&s.points.length>1){
      ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i].x,s.points[i].y);
      ctx.stroke();
    }else if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      const len=Math.sqrt(dx*dx+dy*dy);
      if(len<5*scale)return;
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);ctx.lineTo(s.end.x,s.end.y);ctx.stroke();
      ctx.setLineDash([]);
      // Arrowhead
      const angle=Math.atan2(dy,dx);
      ctx.beginPath();
      ctx.moveTo(s.end.x,s.end.y);
      ctx.lineTo(s.end.x-hl*Math.cos(angle-0.4),s.end.y-hl*Math.sin(angle-0.4));
      ctx.moveTo(s.end.x,s.end.y);
      ctx.lineTo(s.end.x-hl*Math.cos(angle+0.4),s.end.y-hl*Math.sin(angle+0.4));
      ctx.stroke();
    }else if(s.type==="circle"&&s.start&&s.end){
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      const cx=Math.min(s.start.x,s.end.x)+rx,cy=Math.min(s.start.y,s.end.y)+ry;
      if(rx<3*scale&&ry<3*scale)return;
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.stroke();
      ctx.setLineDash([]);
    }else if(s.type==="rect"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w<3*scale&&h<3*scale)return;
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.rect(x,y,w,h);ctx.stroke();
      ctx.setLineDash([]);
    }else if(s.type==="line"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      if(Math.sqrt(dx*dx+dy*dy)<3*scale)return;
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);ctx.lineTo(s.end.x,s.end.y);ctx.stroke();
      ctx.setLineDash([]);
    }else if(s.type==="dimension"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<5*scale)return;
      const tick=hl*0.8;
      const nx=(-dy/len)*tick,ny=(dx/len)*tick;
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);ctx.lineTo(s.end.x,s.end.y);ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(s.start.x+nx,s.start.y+ny);ctx.lineTo(s.start.x-nx,s.start.y-ny);ctx.stroke();
      ctx.beginPath();ctx.moveTo(s.end.x+nx,s.end.y+ny);ctx.lineTo(s.end.x-nx,s.end.y-ny);ctx.stroke();
      const dimLabel=s.label||"";
      if(dimLabel){
        const mx=(s.start.x+s.end.x)/2,my=(s.start.y+s.end.y)/2;
        ctx.save();ctx.translate(mx,my);
        const angle=Math.atan2(dy,dx);
        ctx.rotate(angle>Math.PI/2||angle<-Math.PI/2?angle+Math.PI:angle);
        ctx.font=`bold ${fontSize}px 'Barlow Condensed',sans-serif`;
        ctx.textAlign="center";ctx.textBaseline="bottom";
        ctx.fillText(dimLabel,0,-4*scale);
        ctx.restore();
      }
    }else if(s.type==="text"&&s.pos&&s.text){
      ctx.font=`bold ${fontSize}px 'Barlow Condensed',sans-serif`;
      ctx.fillStyle=s.color;
      // Background
      const metrics=ctx.measureText(s.text);
      const pad=4*scale;
      ctx.fillStyle="rgba(0,0,0,0.6)";
      ctx.fillRect(s.pos.x-pad/2,s.pos.y-fontSize,metrics.width+pad*2,fontSize*1.4);
      ctx.fillStyle=s.color;
      ctx.fillText(s.text,s.pos.x+pad/2,s.pos.y);
    }else if(s.type==="cloud"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w>3*scale||h>3*scale){
        ctx.beginPath();
        const arcsPerW=Math.max(4,Math.round(w/(18*scale))),arcsPerH=Math.max(4,Math.round(h/(18*scale)));
        const dw=w/arcsPerW,dh=h/arcsPerH,r=Math.max(dw,dh)*0.55;
        for(let i=0;i<arcsPerW;i++){const cx=x+dw*i+dw/2;ctx.arc(cx,y,r,Math.PI,0);}
        for(let i=0;i<arcsPerH;i++){const cy=y+dh*i+dh/2;ctx.arc(x+w,cy,r,-Math.PI/2,Math.PI/2);}
        for(let i=arcsPerW-1;i>=0;i--){const cx=x+dw*i+dw/2;ctx.arc(cx,y+h,r,0,Math.PI);}
        for(let i=arcsPerH-1;i>=0;i--){const cy=y+dh*i+dh/2;ctx.arc(x,cy,r,Math.PI/2,-Math.PI/2);}
        ctx.stroke();
      }
    }else if(s.type==="callout"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      const angle=Math.atan2(dy,dx);
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);ctx.lineTo(s.end.x,s.end.y);ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);
      ctx.lineTo(s.start.x+hl*Math.cos(angle-0.4),s.start.y+hl*Math.sin(angle-0.4));
      ctx.moveTo(s.start.x,s.start.y);
      ctx.lineTo(s.start.x+hl*Math.cos(angle+0.4),s.start.y+hl*Math.sin(angle+0.4));
      ctx.stroke();
      if(s.text){
        ctx.font=`bold ${fontSize}px 'Barlow Condensed',sans-serif`;
        const metrics=ctx.measureText(s.text);
        const pad=4*scale;
        ctx.fillStyle="rgba(255,255,255,0.92)";
        ctx.strokeStyle=s.color;ctx.lineWidth=2*scale;
        const bx=s.end.x-pad,by=s.end.y-fontSize-pad;
        ctx.beginPath();ctx.rect(bx,by,metrics.width+pad*2,fontSize+pad*2);ctx.fill();ctx.stroke();
        ctx.fillStyle=s.color;ctx.textBaseline="alphabetic";ctx.textAlign="left";
        ctx.fillText(s.text,s.end.x,s.end.y);
      }
    }else if(s.type==="highlight"&&s.points&&s.points.length>1){
      ctx.save();
      ctx.globalAlpha=0.3;
      ctx.lineWidth=15*scale;
      ctx.lineCap="round";ctx.lineJoin="round";
      ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i].x,s.points[i].y);
      ctx.stroke();
      ctx.restore();
    }else if(s.type==="polyline"&&s.points&&s.points.length>1){
      if(s.lineStyle==="dotted")ctx.setLineDash([6*scale,4*scale]);
      ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i].x,s.points[i].y);
      if(s.closed)ctx.closePath();
      ctx.stroke();ctx.setLineDash([]);
    }else if(s.type==="stamp"&&s.pos){
      const text=s.text||s.stampId||"STAMP";
      ctx.save();
      ctx.translate(s.pos.x,s.pos.y);ctx.rotate(-15*Math.PI/180);
      ctx.font=`bold ${fontSize}px Arial`;
      const tw=ctx.measureText(text).width;
      const pad=fontSize*0.4;
      const stampColor=s.stampId==="APPROVED"?"#34c759":s.stampId==="REJECTED"?"#ff3b30":s.stampId==="REVIEWED"?"#007aff":s.color||"#ff9500";
      ctx.strokeStyle=stampColor;ctx.lineWidth=Math.max(2,fontSize*0.08);
      ctx.strokeRect(-tw/2-pad,-fontSize/2-pad,tw+pad*2,fontSize+pad*2);
      ctx.fillStyle=stampColor;ctx.globalAlpha=0.85;
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(text,0,0);
      ctx.restore();
    }
  };

  const getPos=e=>{
    const rect=canvasRef.current.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{x:t.clientX-rect.left,y:t.clientY-rect.top};
  };

  const[editingTextIdx,setEditingTextIdx]=useState(null);

  const hitTestText=(p)=>{
    // Check if tap is on an existing text annotation (search in reverse for top-most)
    const canvas=canvasRef.current;if(!canvas)return -1;
    const ctx=canvas.getContext("2d");
    for(let i=strokes.length-1;i>=0;i--){
      const s=strokes[i];
      if(s.type!=="text"||!s.pos||!s.text)continue;
      ctx.font="bold 16px 'Barlow Condensed',sans-serif";
      const metrics=ctx.measureText(s.text);
      const x1=s.pos.x-2,y1=s.pos.y-16,w=metrics.width+8,h=22;
      if(p.x>=x1&&p.x<=x1+w&&p.y>=y1&&p.y<=y1+h)return i;
    }
    return -1;
  };

  const hitTestStroke=(p)=>{
    const canvas=canvasRef.current;if(!canvas)return -1;
    const ctx=canvas.getContext("2d");
    for(let i=strokes.length-1;i>=0;i--){
      const s=strokes[i];
      if(s.type==="text"&&s.pos&&s.text){
        ctx.font=`bold ${s.textSize||16}px 'Barlow Condensed',sans-serif`;
        const m=ctx.measureText(s.text);
        if(p.x>=s.pos.x-4&&p.x<=s.pos.x+m.width+8&&p.y>=s.pos.y-(s.textSize||16)&&p.y<=s.pos.y+6)return i;
      }else if((s.type==="freehand"||s.type==="highlight")&&s.points){
        for(const pt of s.points){if(Math.abs(p.x-pt.x)<(s.type==="highlight"?18:10)&&Math.abs(p.y-pt.y)<(s.type==="highlight"?18:10))return i;}
      }else if(s.type==="polyline"&&s.points){
        for(const pt of s.points){if(Math.abs(p.x-pt.x)<10&&Math.abs(p.y-pt.y)<10)return i;}
      }else if(s.type==="stamp"&&s.pos){
        if(Math.abs(p.x-s.pos.x)<40&&Math.abs(p.y-s.pos.y)<20)return i;
      }else if(s.type==="callout"&&s.start&&s.end){
        // Hit on line or text box
        const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
        if(Math.abs(p.x-cx)<Math.abs(s.end.x-s.start.x)/2+15&&Math.abs(p.y-cy)<Math.abs(s.end.y-s.start.y)/2+15)return i;
      }else if(s.start&&s.end){
        const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
        if(Math.abs(p.x-cx)<Math.abs(s.end.x-s.start.x)/2+10&&Math.abs(p.y-cy)<Math.abs(s.end.y-s.start.y)/2+10)return i;
      }
    }
    return -1;
  };
  const onDown=e=>{
    e.preventDefault();
    const p=getPos(e);
    if(tool==="select"){
      const hit=hitTestStroke(p);
      setSelectedIdx(hit>=0?hit:null);
      if(hit>=0)dragRef.current={idx:hit,startPos:p,origStroke:JSON.parse(JSON.stringify(strokes[hit]))};
      else dragRef.current=null;
      return;
    }
    if(tool==="text"){
      const hitIdx=hitTestText(p);
      if(hitIdx>=0){setEditingTextIdx(hitIdx);setTextInput(strokes[hitIdx].pos);return;}
      setTextInput(p);return;
    }
    if(tool==="polyline"){
      setPolylinePoints(prev=>[...prev,p]);
      return;
    }
    if(tool==="stamp"){
      addStroke({type:"stamp",color,pos:p,stampId:stampType,text:stampType,textSize});
      return;
    }
    if(tool==="freehand")setCurrent({type:"freehand",color,points:[p]});
    else if(tool==="highlight")setCurrent({type:"highlight",color,points:[p]});
    else setCurrent({type:tool,color,lineStyle,start:p,end:p});
  };
  const onMove=e=>{
    if(dragRef.current){
      e.preventDefault();
      const p=getPos(e);
      const dx=p.x-dragRef.current.startPos.x,dy=p.y-dragRef.current.startPos.y;
      const orig=dragRef.current.origStroke;
      setStrokes(s=>s.map((st,i)=>{
        if(i!==dragRef.current.idx)return st;
        if(orig.pos)return{...st,pos:{x:orig.pos.x+dx,y:orig.pos.y+dy}};
        if(orig.start&&orig.end)return{...st,start:{x:orig.start.x+dx,y:orig.start.y+dy},end:{x:orig.end.x+dx,y:orig.end.y+dy}};
        if(orig.points)return{...st,points:orig.points.map(pt=>({x:pt.x+dx,y:pt.y+dy}))};
        return st;
      }));
      return;
    }
    if(!current)return;
    e.preventDefault();
    const p=getPos(e);
    if(current.type==="freehand"||current.type==="highlight")setCurrent(c=>({...c,points:[...c.points,p]}));
    else setCurrent(c=>({...c,end:p}));
  };
  const onUp=()=>{
    dragRef.current=null;
    if(current){
      if(current.type==="dimension"){
        const label=prompt(t("markup.enter_dimension"))||"";
        addStroke({...current,label:label.trim()});setCurrent(null);
        return;
      }
      if(current.type==="callout"){
        setCalloutTextInput(current);setCurrent(null);
        return;
      }
      addStroke(current);setCurrent(null);
    }
  };
  const finishPolyline=()=>{
    if(polylinePoints.length>1){
      addStroke({type:"polyline",color,points:[...polylinePoints],closed:polylineClosed,lineStyle});
    }
    setPolylinePoints([]);
  };

  const submitText=(text)=>{
    if(text&&textInput){
      if(editingTextIdx!==null){
        setStrokes(s=>s.map((st,i)=>i===editingTextIdx?{...st,text,color,textSize}:st));
      }else{
        addStroke({type:"text",color,pos:textInput,text,textSize});
      }
    }else if(!text&&editingTextIdx!==null){
      setStrokes(s=>s.filter((_,i)=>i!==editingTextIdx));
    }
    setEditingTextIdx(null);
    setTextInput(null);
  };

  const save=()=>{
    if(!canvasRef.current)return;
    // Render at full resolution for quality
    const img=imgRef.current;
    const fc=document.createElement("canvas");
    fc.width=img.width;fc.height=img.height;
    const fctx=fc.getContext("2d");
    fctx.drawImage(img,0,0);
    // Scale strokes to full resolution
    const sx=img.width/sizeRef.current.w,sy=img.height/sizeRef.current.h;
    const scaleStroke=s=>{
      if((s.type==="freehand"||s.type==="highlight"||s.type==="polyline")&&s.points)return{...s,points:s.points.map(p=>({x:p.x*sx,y:p.y*sy}))};
      if(s.type==="text"||s.type==="stamp")return{...s,pos:{x:s.pos.x*sx,y:s.pos.y*sy}};
      if(s.type==="callout")return{...s,start:{x:s.start.x*sx,y:s.start.y*sy},end:{x:s.end.x*sx,y:s.end.y*sy}};
      return{...s,start:{x:s.start.x*sx,y:s.start.y*sy},end:{x:s.end.x*sx,y:s.end.y*sy}};
    };
    strokes.forEach(s=>{
      const scaled=scaleStroke(s);
      drawStroke(fctx,scaled,sx);
    });
    onSave(fc.toDataURL("image/jpeg",0.92));
  };

  const[textSize,setTextSize]=useState(16);
  const[selectedIdx,setSelectedIdx]=useState(null);
  const deleteSelected=()=>{if(selectedIdx!=null){setStrokes(s=>s.filter((_,i)=>i!==selectedIdx));setSelectedIdx(null);}};

  const TOOLS=[
    {id:"select",title:t("markup.select")},
    {id:"freehand",title:t("markup.draw")},
    {id:"highlight",title:t("markup.highlight")},
    {id:"line",title:t("markup.line")},
    {id:"arrow",title:t("markup.arrow")},
    {id:"polyline",title:t("markup.polyline")},
    {id:"circle",title:t("markup.circle")},
    {id:"rect",title:t("markup.rectangle")},
    {id:"cloud",title:t("markup.cloud")},
    {id:"dimension",title:t("markup.dimension")},
    {id:"text",title:t("markup.text")},
    {id:"callout",title:t("markup.callout")},
    {id:"stamp",title:t("markup.stamp")}
  ];
  const TEXT_SIZES=[{id:"S",v:12},{id:"M",v:16},{id:"L",v:22},{id:"XL",v:30}];
  const COLORS=["#ff3b30","#ff9500","#ffcc00","#fff"];

  return(
    <div style={{position:"fixed",inset:0,background:"#1a1a1a",zIndex:300,display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
        <button onClick={onCancel} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.cancel")}</button>
        <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",textAlign:"center"}}>MARKUP PHOTO</div>
        <button onClick={save} style={{background:"#ff6b00",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.save")}</button>
      </div>

      {/* Toolbar */}
      <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:6,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0,flexWrap:"wrap"}}>
        {TOOLS.map(t=>(
          <button key={t.id} onClick={()=>{setTool(t.id);if(t.id!=="select")setSelectedIdx(null);}} title={t.title} style={{width:36,height:36,borderRadius:8,border:tool===t.id?"2px solid #ff6b00":"2px solid rgba(255,255,255,0.15)",background:tool===t.id?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {t.id==="select"?<svg width="16" height="16" viewBox="0 0 20 20"><path d="M4 2 L4 15 L7.5 12 L10 17 L12 16 L9.5 11 L14 11 Z" fill="#fff" stroke="#fff" strokeWidth="0.8" strokeLinejoin="round"/></svg>
            :t.id==="freehand"?"✏"
            :t.id==="highlight"?<svg width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="7" width="16" height="6" rx="1" fill="#fff" opacity="0.5"/><line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.4"/></svg>
            :t.id==="line"?<svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg>
            :t.id==="arrow"?"↗"
            :t.id==="polyline"?<svg width="20" height="20" viewBox="0 0 20 20"><polyline points="2,16 7,4 13,14 18,6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            :t.id==="circle"?<svg width="20" height="20" viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="8" ry="8" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
            :t.id==="rect"?<svg width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="12" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
            :t.id==="cloud"?<svg width="20" height="20" viewBox="0 0 20 20"><path d="M4,14 A3,3 0 0,1 4,8 A4,4 0 0,1 8,5 A4,4 0 0,1 14,5 A4,4 0 0,1 17,8 A3,3 0 0,1 17,14 Z" fill="none" stroke="#fff" strokeWidth="1.2"/></svg>
            :t.id==="dimension"?<svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="#fff" strokeWidth="1"/><line x1="3" y1="6" x2="3" y2="14" stroke="#fff" strokeWidth="1.5"/><line x1="17" y1="6" x2="17" y2="14" stroke="#fff" strokeWidth="1.5"/><text x="10" y="8" fill="#fff" fontSize="6" textAnchor="middle" fontFamily="sans-serif">d</text></svg>
            :t.id==="text"?"T"
            :t.id==="callout"?<svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="16" x2="10" y2="6" stroke="#fff" strokeWidth="1.2"/><rect x="9" y="2" width="9" height="7" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.2"/><text x="13.5" y="7.5" fill="#fff" fontSize="5" textAnchor="middle" fontFamily="sans-serif">A</text></svg>
            :t.id==="stamp"?"⊞":""}
          </button>
        ))}
        <div style={{width:1,height:24,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
        {COLORS.map(c=>(
          <button key={c} onClick={()=>{setColor(c);if(selectedIdx!=null)setStrokes(s=>s.map((st,i)=>i===selectedIdx?{...st,color:c}:st));}} style={{width:28,height:28,borderRadius:"50%",border:color===c?"3px solid #fff":"3px solid rgba(255,255,255,0.15)",background:c,cursor:"pointer"}}/>
        ))}
        <button onClick={()=>setLineStyle(s=>s==="solid"?"dotted":"solid")} title={lineStyle==="solid"?t("markup.solid"):t("markup.dotted")} style={{width:36,height:36,borderRadius:8,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            {lineStyle==="solid"
              ?<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
              :<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3"/>}
          </svg>
        </button>
        {/* Text size */}
        {TEXT_SIZES.map(sz=>(
          <button key={sz.id} onClick={()=>{setTextSize(sz.v);if(selectedIdx!=null){const st=strokes[selectedIdx];if(st?.type==="text"||st?.type==="callout"||st?.type==="stamp")setStrokes(s=>s.map((x,i)=>i===selectedIdx?{...x,textSize:sz.v}:x));}}} style={{minWidth:28,height:28,padding:"0 4px",borderRadius:6,border:textSize===sz.v?"2px solid #ff6b00":"2px solid rgba(255,255,255,0.15)",background:textSize===sz.v?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{sz.id}</button>
        ))}
        {/* Stamp picker */}
        {tool==="stamp"&&(
          <div style={{position:"relative"}}>
            <button onClick={()=>setShowStampMenu(v=>!v)} style={{height:28,padding:"0 8px",borderRadius:6,border:"2px solid rgba(255,107,0,0.4)",background:"rgba(255,107,0,0.15)",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{stampType}</button>
            {showStampMenu&&<div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:6,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",maxHeight:200,overflowY:"auto",minWidth:140}}>
              {STAMP_PRESETS.map(st=>(
                <button key={st} onClick={()=>{setStampType(st);setShowStampMenu(false);}} style={{display:"block",width:"100%",padding:"5px 8px",border:"none",borderRadius:4,background:stampType===st?"rgba(255,107,0,0.25)":"none",color:st==="APPROVED"?"#34c759":st==="REJECTED"?"#ff3b30":st==="REVIEWED"?"#007aff":"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:10,cursor:"pointer",textAlign:"left",marginBottom:2}}>{st}</button>
              ))}
            </div>}
          </div>
        )}
        {/* Polyline controls */}
        {tool==="polyline"&&polylinePoints.length>0&&(
          <>
            <button onClick={()=>setPolylineClosed(v=>!v)} style={{height:28,padding:"0 8px",borderRadius:6,border:polylineClosed?"2px solid #ff6b00":"2px solid rgba(255,255,255,0.15)",background:polylineClosed?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{polylineClosed?t("markup.polygon"):t("markup.open_shape")}</button>
            <button onClick={finishPolyline} style={{height:28,padding:"0 10px",borderRadius:6,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>{t("actions.done")} ({polylinePoints.length}pts)</button>
          </>
        )}
        <div style={{flex:1}}/>
        {selectedIdx!=null&&tool==="select"&&(
          <button onClick={deleteSelected} style={{background:"rgba(255,59,48,0.25)",border:"1px solid rgba(255,59,48,0.45)",borderRadius:8,padding:"6px 10px",color:"#ff8f8f",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>{t("actions.delete")}</button>
        )}
        <button onClick={undo} disabled={strokes.length===0} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"7px 12px",color:strokes.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.undo")}</button>
        <button onClick={redo} disabled={redoStack.length===0} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"7px 12px",color:redoStack.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.redo")}</button>
      </div>

      {/* Canvas */}
      <div style={{flex:1,overflow:"auto",display:"flex",alignItems:"flex-start",justifyContent:"center",padding:8}}>
        {imgLoaded?(
          <div style={{position:"relative",width:"100%",maxWidth:800}}>
            <canvas ref={canvasRef} style={{width:"100%",display:"block",borderRadius:8,touchAction:"none"}}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
              onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}/>
          </div>
        ):<div style={{color:"rgba(255,255,255,0.4)",padding:40}}><Spin size={20}/></div>}
      </div>

      {/* Text input modal */}
      {textInput&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",zIndex:310,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:20,width:"100%",maxWidth:360}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:12}}>{editingTextIdx!==null?"EDIT TEXT ANNOTATION":"ADD TEXT ANNOTATION"}</div>
            <input autoFocus type="text" placeholder={t("markup.type_annotation")} defaultValue={editingTextIdx!==null?strokes[editingTextIdx].text:""} onKeyDown={e=>{if(e.key==="Enter")submitText(e.target.value);}}
              style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setEditingTextIdx(null);setTextInput(null);}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.cancel")}</button>
              {editingTextIdx!==null&&<button onClick={()=>submitText("")} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#ff3b30",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.delete")}</button>}
              <button onClick={e=>{const inp=e.target.closest("div").parentElement.querySelector("input");submitText(inp.value);}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{editingTextIdx!==null?t("actions.update"):t("actions.add")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Callout text modal */}
      {calloutTextInput&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",zIndex:310,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:20,width:"100%",maxWidth:360}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:12}}>CALLOUT LABEL</div>
            <input autoFocus type="text" placeholder={t("markup.enter_callout")} onKeyDown={e=>{if(e.key==="Enter"){const t=e.target.value.trim();addStroke({...calloutTextInput,text:t,textSize});setCalloutTextInput(null);}}}
              style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{addStroke({...calloutTextInput,text:""});setCalloutTextInput(null);}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.skip")}</button>
              <button onClick={e=>{const inp=e.target.closest("div").parentElement.querySelector("input");addStroke({...calloutTextInput,text:(inp.value||"").trim(),textSize});setCalloutTextInput(null);}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.add")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AI_PROMPT='Analyze this construction defect photo. Respond in valid JSON only, no markdown: {"title":"max 5 word defect title","severity":"one of Critical Major Minor Observation","description":"2 sentence technical description","trade":"responsible trade e.g. Plumbing Electrical Waterproofing Painting Tiling Structural Carpentry Aircon General","safety_risk":1 to 5 integer where 5 is life-threatening hazard and 1 is cosmetic,"suggested_assignee":"trade role to assign e.g. Plumber Electrician Painter Tiler Contractor"}';

// Cache the model name the user's Gemini key actually has access to, so we
// don't hardcode against a model that may be renamed/retired by Google.
const GEMINI_MODEL_KEY="sdt-gemini-model-v1";
const GEMINI_MODEL_FALLBACKS=["gemini-2.5-flash","gemini-2.0-flash","gemini-1.5-flash","gemini-1.5-flash-latest","gemini-pro"];

// Probe the Gemini models endpoint and return the first vision-capable model
// that works with the given key. Caches the result.
async function pickGeminiModel(apiKey){
  const cached=local.get(GEMINI_MODEL_KEY);
  if(cached)return cached;
  try{
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if(!r.ok)return GEMINI_MODEL_FALLBACKS[0];
    const d=await r.json();
    const names=(d.models||[]).map(m=>(m.name||"").replace(/^models\//,"")).filter(n=>n.includes("gemini"));
    // Prefer fallback order; else pick first "flash" from available list
    for(const want of GEMINI_MODEL_FALLBACKS){if(names.includes(want)){local.set(GEMINI_MODEL_KEY,want);return want;}}
    const firstFlash=names.find(n=>n.includes("flash"))||names[0];
    if(firstFlash){local.set(GEMINI_MODEL_KEY,firstFlash);return firstFlash;}
  }catch{}
  return GEMINI_MODEL_FALLBACKS[0];
}

// Call Gemini generateContent, auto-retrying once with a fresh model pick
// if the request 404s (model name changed/retired).
async function geminiGenerate(apiKey,body){
  let model=await pickGeminiModel(apiKey);
  const call=async m=>fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  let res=await call(model);
  if(res.status===404){
    local.del(GEMINI_MODEL_KEY);
    model=await pickGeminiModel(apiKey);
    res=await call(model);
  }
  return res;
}

async function analyzeWithGemini(apiKey,base64Image){
  try{
    const b64=base64Image.split(",")[1];
    const res=await geminiGenerate(apiKey,{contents:[{parts:[
      {inline_data:{mime_type:"image/jpeg",data:b64}},
      {text:AI_PROMPT}
    ]}]});
    const data=await res.json();
    const parts=data.candidates?.[0]?.content?.parts||[];
    const nonThought=parts.filter(p=>p.text&&!p.thought);
    const text=(nonThought.length?nonThought.pop():parts.filter(p=>p.text).pop()||{}).text||"{}";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  }catch{return null;}
}

async function analyzeWithOllama(cfg,base64Image){
  try{
    const b64=base64Image.split(",")[1];
    const url=(cfg.url||"http://localhost:11434").replace(/\/+$/,"");
    const model=cfg.model||"llava";
    const res=await fetch(url+"/api/generate",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model,prompt:AI_PROMPT,images:[b64],stream:false})
    });
    const data=await res.json();
    const text=data.response||"{}";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  }catch{return null;}
}

async function analyzeWithOpenAI(cfg,base64Image){
  try{
    const b64=base64Image.split(",")[1];
    const url=(cfg.url||"https://api.openai.com").replace(/\/+$/,"");
    const model=cfg.model||"gpt-4o-mini";
    const res=await fetch(url+"/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+cfg.apiKey},
      body:JSON.stringify({model,max_tokens:300,messages:[{role:"user",content:[
        {type:"image_url",image_url:{url:"data:image/jpeg;base64,"+b64,detail:"low"}},
        {type:"text",text:AI_PROMPT}
      ]}]})
    });
    const data=await res.json();
    const text=data.choices?.[0]?.message?.content||"{}";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  }catch{return null;}
}

// Unified dispatcher — picks the right provider based on user settings
async function analyzePhoto(base64Image){
  const provider=local.get(AI_PROVIDER_KEY)||"gemini";
  if(provider==="ollama"){
    const cfg=local.get(OLLAMA_KEY)||{};
    return analyzeWithOllama(cfg,base64Image);
  }
  if(provider==="openai"){
    const cfg=local.get(OPENAI_KEY)||{};
    return analyzeWithOpenAI(cfg,base64Image);
  }
  // Default: Gemini
  const key=local.get(GEMINI_KEY);
  if(!key)return null;
  return analyzeWithGemini(key,base64Image);
}

// Text-only AI query (no image) — for natural language search
async function askAI(prompt){
  const provider=local.get(AI_PROVIDER_KEY)||"gemini";
  try{
    if(provider==="gemini"){
      const key=local.get(GEMINI_KEY);if(!key)return null;
      const res=await geminiGenerate(key,{contents:[{parts:[{text:prompt}]}]});
      const data=await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text||null;
    }
    if(provider==="ollama"){
      const cfg=local.get(OLLAMA_KEY)||{};
      const res=await fetch(`${cfg.url}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:cfg.model||"llama3",prompt,stream:false})});
      const data=await res.json();return data.response||null;
    }
    if(provider==="openai"){
      const cfg=local.get(OPENAI_KEY)||{};
      const res=await fetch(`${cfg.url||"https://api.openai.com"}/v1/chat/completions`,{method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+cfg.apiKey},
        body:JSON.stringify({model:cfg.model||"gpt-4o-mini",messages:[{role:"user",content:prompt}]})});
      const data=await res.json();return data.choices?.[0]?.message?.content||null;
    }
  }catch{return null;}
  return null;
}

// askAI variant that also returns token usage from the API response
async function askAIWithUsage(prompt){
  const provider=local.get(AI_PROVIDER_KEY)||"gemini";
  try{
    if(provider==="gemini"){
      const key=local.get(GEMINI_KEY);if(!key)return{text:null,tokens:null};
      const res=await geminiGenerate(key,{contents:[{parts:[{text:prompt}]}]});
      const data=await res.json();
      const text=data.candidates?.[0]?.content?.parts?.[0]?.text||null;
      const u=data.usageMetadata||{};
      return{text,tokens:{prompt:u.promptTokenCount||0,completion:u.candidatesTokenCount||0,total:u.totalTokenCount||0,provider:"Gemini"}};
    }
    if(provider==="ollama"){
      const cfg=local.get(OLLAMA_KEY)||{};
      const res=await fetch(`${cfg.url}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:cfg.model||"llama3",prompt,stream:false})});
      const data=await res.json();
      return{text:data.response||null,tokens:{prompt:data.prompt_eval_count||0,completion:data.eval_count||0,total:(data.prompt_eval_count||0)+(data.eval_count||0),provider:"Ollama"}};
    }
    if(provider==="openai"){
      const cfg=local.get(OPENAI_KEY)||{};
      const res=await fetch(`${cfg.url||"https://api.openai.com"}/v1/chat/completions`,{method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+cfg.apiKey},
        body:JSON.stringify({model:cfg.model||"gpt-4o-mini",messages:[{role:"user",content:prompt}]})});
      const data=await res.json();
      const u=data.usage||{};
      return{text:data.choices?.[0]?.message?.content||null,tokens:{prompt:u.prompt_tokens||0,completion:u.completion_tokens||0,total:u.total_tokens||0,provider:"OpenAI"}};
    }
  }catch{return{text:null,tokens:null};}
  return{text:null,tokens:null};
}

function isAiConfigured(){
  const provider=local.get(AI_PROVIDER_KEY)||"gemini";
  if(provider==="gemini")return !!local.get(GEMINI_KEY);
  if(provider==="ollama"){const c=local.get(OLLAMA_KEY);return !!(c&&c.url);}
  if(provider==="openai"){const c=local.get(OPENAI_KEY);return !!(c&&c.apiKey);}
  return false;
}

const CONTRACT_CLAUSE_USES=[
  "General compliance",
  "Defects liability",
  "Extensions of time",
  "Variations",
  "Payment / claims",
  "Quality and workmanship",
  "Safety and statutory obligations"
];

// ── Contract PDF manifest ──────────────────────────────────────────
const CONTRACT_FILES={
  PSSCOC:[
    "PSSCOC for Construction Works 2020.pdf",
    "PSSCOC for Construction Works Lite 2025.pdf",
    "PSSCOC for Design and Build 2020.pdf"
  ],
  REDAS:[
    "REDAS Design and Build Conditions of Contract 3rd Ed.pdf"
  ],
  SIA:[
    "Nominated SubContract for Constuction Works 2008.pdf",
    "Nominated SubContract for Constuction Works 2008 Supplement.pdf",
    "SIA BC 2016 [With Quantities].pdf",
    "SIA Building Contract 2016 [With Quantities].pdf",
    "SIA Minor Works Contract 2012.pdf"
  ]
};

// ── PDF text extraction via PDF.js ─────────────────────────────────
async function extractPdfText(url,maxChars=12000){
  if(!window.pdfjsLib)throw new Error("PDF.js not loaded");
  const pdfjsLib=window.pdfjsLib;
  if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf=await pdfjsLib.getDocument(url).promise;
  let text="";
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const content=await page.getTextContent();
    const pageText=content.items.map(item=>item.str).join(" ");
    text+=pageText+"\n";
    if(text.length>=maxChars)break;
  }
  return text.slice(0,maxChars).trim();
}

// ── Extract texts from selected contract folders ───────────────────
async function extractContractTexts({usePssoc,useRedas,useSia,onProgress}){
  const results=[];
  const folders=[];
  if(usePssoc)folders.push({label:"PSSCOC",path:"contracts/PSSCOC",files:CONTRACT_FILES.PSSCOC});
  if(useRedas)folders.push({label:"REDAS",path:"contracts/REDAS",files:CONTRACT_FILES.REDAS});
  if(useSia)folders.push({label:"SIA",path:"contracts/SIA",files:CONTRACT_FILES.SIA});

  const maxPerFile=10000;
  const maxTotal=40000;
  let totalLen=0;

  for(const folder of folders){
    for(const file of folder.files){
      if(totalLen>=maxTotal)break;
      const url=`${folder.path}/${file}`;
      if(onProgress)onProgress(`Reading: ${file}`);
      try{
        const remaining=maxTotal-totalLen;
        const cap=Math.min(maxPerFile,remaining);
        const text=await extractPdfText(url,cap);
        if(text){
          results.push({source:`${folder.label}: ${file}`,text});
          totalLen+=text.length;
        }
      }catch(e){
        results.push({source:`${folder.label}: ${file}`,text:`(Failed to extract: ${e.message||"unknown error"})`});
      }
    }
  }
  return results;
}

function buildContractAdvisorPrompt({clauseUse,contextText,sourceMode,usePssoc,useRedas,useSia,uploadSummaries,uploadExtracts,extractedTexts,defectsSummary}){
  const selectedSources=[];
  if(sourceMode==="existing"){
    if(usePssoc)selectedSources.push("PSSCOC (public)");
    if(useRedas)selectedSources.push("REDAS (private)");
    if(useSia)selectedSources.push("SIA (private)");
  }

  const sourceSection=sourceMode==="existing"
    ? `Selected contract sources: ${selectedSources.join(", ")||"None selected"}`
    : `User uploaded files:\n${uploadSummaries||"No upload metadata provided"}`;

  // Build extracted clause evidence block
  let evidenceBlock="";
  if(extractedTexts&&extractedTexts.length>0){
    evidenceBlock="═══ EXTRACTED CONTRACT TEXT (read from actual PDFs) ═══\n"+
      extractedTexts.map(e=>`── ${e.source} ──\n${e.text}`).join("\n\n")+
      "\n═══ END OF EXTRACTED TEXT ═══";
  }

  return [
    "You are a Contract Advisor for construction site defect-to-clause analysis.",
    "You have been given ACTUAL TEXT extracted from the contract PDFs below, plus a list of defects/items from the site report.",
    "Cross-reference each defect against the contract clauses to advise the site team.",
    "Base your analysis ONLY on the extracted contract text provided — cite specific clause numbers and exact wording.",
    "Do NOT invent or assume clause numbers that are not in the extracted text.",
    "",
    "CRITICAL: You MUST follow the EXACT output template below. Use the same headings, same order, same format every time.",
    "Do NOT add extra sections, do NOT reorder, do NOT change heading names.",
    "",
    "═══ OUTPUT TEMPLATE (follow exactly) ═══",
    "",
    "SUMMARY",
    "2-3 sentences summarizing the overall contractual position for these defects.",
    "",
    "DEFECT-TO-CLAUSE MAPPING",
    "For each defect (or group of similar defects), output exactly this format:",
    "",
    "▸ Defect: [defect title/description]",
    "  Clause: [Clause No. & Title] — \"[exact quote or close paraphrase from contract]\"",
    "  Source: [which contract document this clause is from]",
    "  Responsible Party: [Contractor / Sub-contractor / SO / Employer / etc.]",
    "  Impact: [defects liability period, rectification timeline, cost implications, safety obligations]",
    "  Action: [specific action required per contractual T&C]",
    "",
    "(Repeat for each defect or group. If no matching clause is found, write: Clause: No matching clause found in extracted text — [state what clause text is needed].)",
    "",
    "RISK NOTES",
    "• [max 4 bullets — flag ambiguities, missing clauses, or cross-clause dependencies]",
    "",
    "RECOMMENDED NEXT STEPS",
    "• [max 5 actionable bullets, each ending with (Responsible: [party])]",
    "",
    "CONFIDENCE: [High / Medium / Low] — [one-line reason based on clause text availability]",
    "",
    "═══ END OF TEMPLATE ═══",
    "",
    `Clause focus: ${clauseUse||"General compliance"}`,
    "",
    defectsSummary?`═══ SITE DEFECTS / ITEMS FROM REPORT ═══\n${defectsSummary}\n═══ END OF DEFECTS ═══`:"No defects provided from report.",
    "",
    contextText?`Additional context from user:\n${contextText}`:"",
    "",
    sourceSection,
    "",
    evidenceBlock||"No contract text was extracted from PDFs.",
    "",
    uploadExtracts?`Additional user-pasted clause extracts:\n${uploadExtracts}`:"",
    "",
    "If the extracted text does not contain relevant clauses for a defect, say so explicitly. Do NOT fabricate clause numbers."
  ].filter(Boolean).join("\n");
}

// ── Custom Entry Types helpers ────────────────────────────────────
function getCustomTypes(){return local.get(CUSTOM_TYPES_KEY)||[];}
function saveCustomTypes(types){local.set(CUSTOM_TYPES_KEY,types);}

// Returns merged list: [...defaults, ...custom names]
function getAllEntryTypes(){return[...ENTRY_TYPES,...getCustomTypes().map(t=>t.name)];}

// Get icon/color/bg for any entry type (default or custom)
function typeIcon(t){
  if(ENTRY_TYPE_ICON[t])return ENTRY_TYPE_ICON[t];
  const custom=getCustomTypes();
  const idx=custom.findIndex(c=>c.name===t);
  if(idx<0)return "\u{1F4DD}";
  if(custom[idx].icon)return custom[idx].icon;
  return CUSTOM_TYPE_ICONS[idx%CUSTOM_TYPE_ICONS.length]||"\u{1F4DD}";
}
function typeColor(t){
  if(ENTRY_TYPE_COLOR[t])return ENTRY_TYPE_COLOR[t];
  const custom=getCustomTypes();
  const idx=custom.findIndex(c=>c.name===t);
  if(idx<0)return "#607d8b";
  if(custom[idx].color)return custom[idx].color;
  return CUSTOM_TYPE_COLORS[idx%CUSTOM_TYPE_COLORS.length]||"#607d8b";
}
function typeBg(t){
  if(ENTRY_TYPE_BG[t])return ENTRY_TYPE_BG[t];
  const c=typeColor(t);
  // Convert hex color to rgba with 0.12 alpha
  const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16);
  return `rgba(${r},${g},${b},0.12)`;
}

function exportCSV(defects,projectName){
  const esc=v=>`"${String(v||"").replace(/"/g,'""')}"`;
  const headers=["ID","Entry Type","Title","Component","Issue","Location","Severity","Status","Assignee","Trade","Logged By","Role","Date","Due Date","Duration","Cost Impact","Cost Responsible","Cost Amount","Description","Comments"];
  const rows=defects.map(d=>[
    d.defect_id||d.id||"",
    d.entryType||"Defect",
    esc(d.title),
    esc(d.component),
    esc(d.issue),
    esc(d.location),
    d.severity||"",
    d.status||"",
    esc(d.assignee),
    esc(d.trade),
    esc(d.loggedBy),
    d.loggedByRole||"",
    (d.createdAt||d.created)?new Date(d.createdAt||d.created).toLocaleDateString("en-GB"):"",
    d.dueDate||"",
    d.duration||"",
    esc(d.costImpact),
    esc(d.costResponsible),
    d.costAmount||"",
    esc(d.description),
    esc((d.comments||[]).map(c=>`${c.by}: ${c.text}`).join(" | "))
  ].join(","));
  const bom="\uFEFF";
  const csv=bom+[headers.join(","),...rows].join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  a.download=`SiteShrimp_${(projectName||"Export").replace(/\s/g,"_")}_${new Date().toLocaleDateString("en-GB").replace(/\//g,"-")}.csv`;
  a.click();
}

// Full report export — defects + drawing annotations + saved comparisons in one CSV
function exportReportAll(defects,drawings,savedComparisons,projectName){
  const esc=v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`;
  const lines=[];
  // Section 1: Defect entries
  lines.push("# DEFECT ENTRIES");
  const defectHeaders=["ID","Entry Type","Title","Component","Issue","Location","Severity","Status","Assignee","Trade","Logged By","Role","Date","Due Date","Duration","Cost Impact","Cost Responsible","Cost Amount","Description","Comments"];
  lines.push(defectHeaders.join(","));
  (defects||[]).forEach(d=>{
    lines.push([
      d.defect_id||d.id||"",
      d.entryType||"Defect",
      esc(d.title),esc(d.component),esc(d.issue),esc(d.location),
      d.severity||"",d.status||"",
      esc(d.assignee),esc(d.trade),esc(d.loggedBy),
      d.loggedByRole||"",
      (d.createdAt||d.created)?new Date(d.createdAt||d.created).toLocaleDateString("en-GB"):"",
      d.dueDate||"",d.duration||"",
      esc(d.costImpact),esc(d.costResponsible),d.costAmount||"",
      esc(d.description),
      esc((d.comments||[]).map(c=>`${c.by}: ${c.text}`).join(" | "))
    ].join(","));
  });
  // Section 2: Drawing annotations (notes + markup counts)
  lines.push("");
  lines.push("# DRAWING ANNOTATIONS");
  lines.push(["Drawing","File","Notes Count","Markup Count","Note #","Note Text","Author","Date"].join(","));
  (drawings||[]).forEach(dr=>{
    const notes=getDrawingNotes(dr.id)||[];
    const markups=getDrawingMarkup(dr.id)||[];
    if(!notes.length&&!markups.length){
      lines.push([esc(dr.name),esc(dr.file),0,0,"","","",""].join(","));
    }else if(!notes.length){
      lines.push([esc(dr.name),esc(dr.file),0,markups.length,"","","",""].join(","));
    }else{
      notes.forEach((n,i)=>{
        lines.push([
          esc(dr.name),esc(dr.file),notes.length,markups.length,
          i+1,esc(n.text||n.note||""),esc(n.by||n.author||""),
          n.at?new Date(n.at).toLocaleDateString("en-GB"):""
        ].join(","));
      });
    }
  });
  // Section 3: Saved comparisons
  lines.push("");
  lines.push("# SAVED COMPARISONS");
  lines.push(["Base","Target","Added","Removed","Date","AI Report"].join(","));
  (savedComparisons||[]).forEach(sc=>{
    lines.push([
      esc(sc.baseName),esc(sc.targetName),
      sc.totalAdded||0,sc.totalRemoved||0,
      sc.savedAt?new Date(sc.savedAt).toLocaleDateString("en-GB"):"",
      sc.aiReport?"Yes":"No"
    ].join(","));
  });
  const csv="\uFEFF"+lines.join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  a.download=`SiteShrimp_Report_${(projectName||"Export").replace(/\s/g,"_")}_${new Date().toLocaleDateString("en-GB").replace(/\//g,"-")}.csv`;
  a.click();
}

// ── OSM tile-stitching helpers for reliable PDF map exports ─────
// The public staticmap.openstreetmap.de service is flaky; instead we
// stitch tile.openstreetmap.org tiles directly (same source the in-app
// Leaflet map uses) and overlay pins. Returns a dataURL PNG.
async function _renderOsmComposite(centerLat,centerLng,zoom,widthPx,heightPx,markers){
  const TILE=256;
  const n=2**zoom;
  const cx=((centerLng+180)/360)*n;
  const cy=((1-Math.asinh(Math.tan(centerLat*Math.PI/180))/Math.PI)/2)*n;
  const leftTile=Math.floor(cx-widthPx/(2*TILE));
  const topTile=Math.floor(cy-heightPx/(2*TILE));
  const tilesX=Math.ceil(widthPx/TILE)+2;
  const tilesY=Math.ceil(heightPx/TILE)+2;
  const canvas=document.createElement("canvas");
  canvas.width=widthPx;canvas.height=heightPx;
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="#e5e3dc";ctx.fillRect(0,0,widthPx,heightPx);
  const offX=(cx-leftTile)*TILE-widthPx/2;
  const offY=(cy-topTile)*TILE-heightPx/2;
  const loadImg=(url)=>new Promise(resolve=>{
    const img=new Image();img.crossOrigin="anonymous";
    img.onload=()=>resolve(img);img.onerror=()=>resolve(null);
    img.src=url;
  });
  const jobs=[];
  for(let dx=0;dx<tilesX;dx++)for(let dy=0;dy<tilesY;dy++){
    const tx=leftTile+dx,ty=topTile+dy;
    if(tx<0||ty<0||tx>=n||ty>=n)continue;
    jobs.push(loadImg(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`).then(img=>({img,dx,dy})));
  }
  const tiles=await Promise.all(jobs);
  tiles.forEach(({img,dx,dy})=>{if(img)ctx.drawImage(img,dx*TILE-offX,dy*TILE-offY,TILE,TILE);});
  (markers||[]).forEach((m,i)=>{
    const mx=((m.lng+180)/360)*n;
    const my=((1-Math.asinh(Math.tan(m.lat*Math.PI/180))/Math.PI)/2)*n;
    const px=(mx-leftTile)*TILE-offX;
    const py=(my-topTile)*TILE-offY;
    if(px<-20||py<-20||px>widthPx+20||py>heightPx+20)return;
    const r=m.label?13:8;
    ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);
    ctx.fillStyle="rgba(0,0,0,0.55)";ctx.fill();
    ctx.lineWidth=3;ctx.strokeStyle=m.color||"#ff6b00";ctx.stroke();
    if(m.label){
      ctx.fillStyle="#fff";
      ctx.font="bold 12px 'Barlow Condensed',sans-serif";
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(String(m.label),px,py+1);
    }else{
      ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);
      ctx.fillStyle=m.color||"#ff6b00";ctx.fill();
    }
  });
  ctx.fillStyle="rgba(255,255,255,0.82)";ctx.fillRect(widthPx-118,heightPx-14,118,14);
  ctx.fillStyle="#555";ctx.font="9px sans-serif";ctx.textAlign="left";ctx.textBaseline="middle";
  ctx.fillText("© OpenStreetMap",widthPx-114,heightPx-7);
  return canvas.toDataURL("image/png");
}
function _osmZoomForBounds(minLat,maxLat,minLng,maxLng,widthPx,heightPx){
  const TILE=256;
  for(let z=18;z>=1;z--){
    const n=2**z;
    const xMin=((minLng+180)/360)*n;
    const xMax=((maxLng+180)/360)*n;
    const yMin=((1-Math.asinh(Math.tan(maxLat*Math.PI/180))/Math.PI)/2)*n;
    const yMax=((1-Math.asinh(Math.tan(minLat*Math.PI/180))/Math.PI)/2)*n;
    if((xMax-xMin)*TILE<=widthPx*0.85&&(yMax-yMin)*TILE<=heightPx*0.85)return z;
  }
  return 1;
}

// Full report export — PDF version with professional layout
async function exportReportPdf(defects,drawings,savedComparisons,projectName,companyName,allPins,contractAdvisory,allDefectsForPins,onProgress,opts){
  opts=opts||{};
  const incMap=opts.incMap!==false;
  const gmapsKey=opts.gmapsKey||"";
  const mapProvider=opts.mapProvider||(gmapsKey?"gmaps":"osm");
  const mapDefects=incMap?(defects||[]).filter(d=>typeof d.lat==="number"&&typeof d.lng==="number"):[];
  if(typeof onProgress==="function")onProgress("Preparing report…");
  const doc=new jspdf.jsPDF("p","mm","a4");
  const pageW=doc.internal.pageSize.getWidth();
  const pageH=doc.internal.pageSize.getHeight();
  const margin=14;
  const contentW=pageW-margin*2;
  let y=18;
  const orange=[255,107,0],purple=[88,86,214];
  const sevRGB={Critical:[255,59,48],Major:[255,149,0],Minor:[230,184,0],Observation:[52,170,220]};
  const statRGB={Open:[255,59,48],"In Progress":[255,149,0],Done:[52,170,220],Verified:[48,209,88],Closed:[142,142,147]};
  const fmtDate=d=>d?new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"—";
  const total=(defects||[]).length;
  const now=new Date();

  // ── Helper: draw colored badge ──
  const badge=(text,x,yy,rgb,w)=>{
    doc.setFontSize(7);doc.setFont(undefined,"bold");
    const bw=w||doc.getTextWidth(text)+6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);doc.roundedRect(x,yy-3.5,bw,5,1.5,1.5,"F");
    doc.setTextColor(255);
    doc.text(text,x+bw/2,yy-0.5,{align:"center"});doc.setTextColor(0);
    return bw;
  };

  // ── Helper: check page break ──
  const checkPage=(need)=>{if(y+need>pageH-15){doc.addPage();y=18;return true;}return false;};

  // ── Helper: section heading ──
  const heading=(text,rgb)=>{
    checkPage(16);
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);doc.roundedRect(margin,y-1,contentW,8,2,2,"F");
    doc.setFontSize(11);doc.setFont(undefined,"bold");doc.setTextColor(255);
    doc.text(text,margin+4,y+4.5);doc.setTextColor(0);y+=12;
  };

  // ── Helper: label + value pair ──
  const field=(lbl,val,x,yy,w)=>{
    doc.setFontSize(6.5);doc.setFont(undefined,"bold");doc.setTextColor(140);
    doc.text(lbl.toUpperCase(),x,yy);
    doc.setFontSize(8);doc.setFont(undefined,"normal");doc.setTextColor(40);
    const lines=doc.splitTextToSize(String(val||"—"),w-2);
    doc.text(lines[0],x,yy+3.5);doc.setTextColor(0);
  };

  // ═══════════════════════════════════════════════════════════════════
  // PAGE 1 — COVER / HEADER
  // ═══════════════════════════════════════════════════════════════════
  // Dark header band
  doc.setFillColor(26,26,26);doc.rect(0,0,pageW,52,"F");
  // Orange accent line
  doc.setFillColor(255,107,0);doc.rect(0,52,pageW,1.5,"F");

  // Company name
  doc.setFontSize(10);doc.setFont(undefined,"bold");doc.setTextColor(255,107,0);
  doc.text((companyName||"SITESHRIMP").toUpperCase(),margin,16);

  // Report title
  doc.setFontSize(24);doc.setFont(undefined,"bold");doc.setTextColor(255);
  doc.text("SITE REPORT",margin,30);

  // Project + date
  doc.setFontSize(11);doc.setFont(undefined,"normal");doc.setTextColor(200);
  doc.text(`${projectName||"Project"} — ${now.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}`,margin,40);

  // Entry count badge — show combined tally
  const drawingCount=(drawings||[]).length;
  const comparisonCount=(savedComparisons||[]).length;
  const parts=[];
  if(total>0)parts.push(`${total} entries`);
  if(drawingCount>0)parts.push(`${drawingCount} drawings`);
  if(comparisonCount>0)parts.push(`${comparisonCount} comparisons`);
  doc.setFontSize(9);doc.setTextColor(255,107,0);
  doc.text(parts.length>0?parts.join(" · "):"No sections selected",margin,48);
  doc.setTextColor(0);
  y=62;

  // ═══════════════════════════════════════════════════════════════════
  // EXECUTIVE SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  heading("EXECUTIVE SUMMARY",orange);

  // Show tallies for each included section
  let xOff=margin;
  if(total>0){
    doc.setFontSize(9);doc.setFont(undefined,"bold");doc.setTextColor(100);
    doc.text("DEFECT ENTRIES",xOff,y);
    doc.setFontSize(28);doc.setFont(undefined,"bold");doc.setTextColor(255,59,48);
    doc.text(String(total),xOff,y+12);
    xOff+=45;
  }
  if(drawingCount>0){
    doc.setFontSize(9);doc.setFont(undefined,"bold");doc.setTextColor(100);
    doc.text("PDF DRAWINGS",xOff,y);
    doc.setFontSize(28);doc.setFont(undefined,"bold");doc.setTextColor(255,107,0);
    doc.text(String(drawingCount),xOff,y+12);
    xOff+=45;
  }
  if(comparisonCount>0){
    doc.setFontSize(9);doc.setFont(undefined,"bold");doc.setTextColor(100);
    doc.text("COMPARISONS",xOff,y);
    doc.setFontSize(28);doc.setFont(undefined,"bold");doc.setTextColor(88,86,214);
    doc.text(String(comparisonCount),xOff,y+12);
    xOff+=45;
  }
  // Overdue count
  const overdue=(defects||[]).filter(d=>d.dueDate&&new Date(d.dueDate)<now&&!["Verified","Closed"].includes(d.status)).length;
  if(overdue>0){
    doc.setFontSize(9);doc.setFont(undefined,"bold");doc.setTextColor(100);
    doc.text("OVERDUE",xOff,y);
    doc.setFontSize(28);doc.setFont(undefined,"bold");doc.setTextColor(255,59,48);
    doc.text(String(overdue),xOff,y+12);
  }
  doc.setTextColor(0);
  y+=18;

  if(total>0){
  // Severity breakdown — horizontal bar chart
  const bySev={};(defects||[]).forEach(d=>{bySev[d.severity]=(bySev[d.severity]||0)+1;});
  doc.setFontSize(8);doc.setFont(undefined,"bold");doc.setTextColor(100);
  doc.text("BY SEVERITY",margin,y);y+=5;
  const barMaxW=contentW*0.6;
  for(const sev of SEVERITY){
    const cnt=bySev[sev]||0;if(cnt===0)continue;
    const rgb=sevRGB[sev]||[100,100,100];
    const barW=total>0?(cnt/total)*barMaxW:0;
    doc.setFontSize(7);doc.setFont(undefined,"bold");doc.setTextColor(rgb[0],rgb[1],rgb[2]);
    doc.text(sev.toUpperCase(),margin,y+2.5);
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);doc.roundedRect(margin+28,y,barW,4,1,1,"F");
    doc.setFontSize(7);doc.setFont(undefined,"bold");doc.setTextColor(40);
    doc.text(String(cnt),margin+28+barW+3,y+3);
    y+=7;
  }
  y+=4;

  // Status breakdown — inline badges
  const byStat={};(defects||[]).forEach(d=>{byStat[d.status]=(byStat[d.status]||0)+1;});
  doc.setFontSize(8);doc.setFont(undefined,"bold");doc.setTextColor(100);
  doc.text("BY STATUS",margin,y);y+=5;
  let bx=margin;
  for(const stat of STATUS){
    const cnt=byStat[stat]||0;
    const rgb=statRGB[stat]||[100,100,100];
    const label=`${stat}: ${cnt}`;
    const bw=badge(label,bx,y+3,rgb);
    bx+=bw+3;
  }
  y+=10;
  }

  // ── Cost Summary ──
  const withCost=(defects||[]).filter(d=>d.costAmount&&String(d.costAmount).trim());
  if(withCost.length>0){
    checkPage(30);
    doc.setFontSize(8);doc.setFont(undefined,"bold");doc.setTextColor(100);
    doc.text("COST SUMMARY",margin,y);y+=5;
    // By trade
    const costByTrade={};const costBySev={};const costByResp={};
    withCost.forEach(d=>{
      const amt=parseFloat(String(d.costAmount).replace(/[^0-9.\-]/g,""))||0;
      const trade=d.component||d.trade||"Unspecified";
      const sev=d.severity||"Unspecified";
      const resp=d.costResponsible||"Unspecified";
      costByTrade[trade]=(costByTrade[trade]||0)+amt;
      costBySev[sev]=(costBySev[sev]||0)+amt;
      costByResp[resp]=(costByResp[resp]||0)+amt;
    });
    const totalCost=withCost.reduce((s,d)=>s+(parseFloat(String(d.costAmount).replace(/[^0-9.\-]/g,""))||0),0);
    doc.setFontSize(8);doc.setFont(undefined,"normal");doc.setTextColor(40);
    doc.text(`Total Cost Impact: $${totalCost.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})} across ${withCost.length} entries`,margin,y);y+=5;

    // Cost table
    const costHeaders=[["Trade","Cost","Entries"]];
    const costRows=Object.entries(costByTrade).sort((a,b)=>b[1]-a[1]).map(([trade,amt])=>[
      trade,
      "$"+amt.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2}),
      String(withCost.filter(d=>(d.component||d.trade||"Unspecified")===trade).length)
    ]);
    doc.autoTable({startY:y,head:costHeaders,body:costRows,margin:{left:margin,right:margin},
      styles:{fontSize:7,cellPadding:2},headStyles:{fillColor:orange,textColor:255,fontStyle:"bold"},
      alternateRowStyles:{fillColor:[252,250,247]},tableWidth:contentW*0.6});
    y=doc.lastAutoTable.finalY+4;

    // Cost by responsible party
    if(Object.keys(costByResp).length>0){
      const respHeaders=[["Responsible Party","Cost"]];
      const respRows=Object.entries(costByResp).sort((a,b)=>b[1]-a[1]).map(([r,amt])=>[
        r,"$"+amt.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})
      ]);
      doc.autoTable({startY:y,head:respHeaders,body:respRows,margin:{left:margin,right:margin},
        styles:{fontSize:7,cellPadding:2},headStyles:{fillColor:[80,80,80],textColor:255,fontStyle:"bold"},
        tableWidth:contentW*0.5});
      y=doc.lastAutoTable.finalY+6;
    }
  }
  y+=4;

  // ═══════════════════════════════════════════════════════════════════
  // DEFECT SUMMARY TABLE — quick reference
  // ═══════════════════════════════════════════════════════════════════
  if(defects&&defects.length>0){
    checkPage(20);
    heading("ENTRY SUMMARY",orange);
    const headers=[["#","Type","Title","Location","Severity","Status","Assignee","Date"]];
    const rows=(defects||[]).map((d,i)=>[
      d.defect_id||String(i+1),
      d.entryType||"Defect",
      (d.title||"").substring(0,55),
      (d.location||"").substring(0,25),
      d.severity||"",
      d.status||"",
      (d.assignee||"").substring(0,18),
      fmtDate(d.createdAt||d.created)
    ]);
    doc.autoTable({startY:y,head:headers,body:rows,margin:{left:margin,right:margin},
      styles:{fontSize:6.5,cellPadding:1.8},
      headStyles:{fillColor:orange,textColor:255,fontStyle:"bold"},
      alternateRowStyles:{fillColor:[252,250,247]},
      columnStyles:{
        0:{cellWidth:12},1:{cellWidth:14},2:{cellWidth:50},3:{cellWidth:28},
        4:{cellWidth:16},5:{cellWidth:18},6:{cellWidth:22},7:{cellWidth:18}
      },
      didParseCell:(data)=>{
        if(data.section==="body"){
          // Color-code severity column
          if(data.column.index===4){
            const rgb=sevRGB[data.cell.raw];
            if(rgb)data.cell.styles.textColor=rgb;
            data.cell.styles.fontStyle="bold";
          }
          // Color-code status column
          if(data.column.index===5){
            const rgb=statRGB[data.cell.raw];
            if(rgb)data.cell.styles.textColor=rgb;
            data.cell.styles.fontStyle="bold";
          }
        }
      }
    });
    y=doc.lastAutoTable.finalY+8;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEFECT DETAIL PAGES — one block per defect with inline photo
  // ═══════════════════════════════════════════════════════════════════
  // Preload all defect photos in parallel for near-zero latency during render
  const photoCache=new Map();
  if(defects&&defects.length>0){
    const photoPromises=[];
    for(const d of defects){
      if(!d.photo)continue;
      const photos=Array.isArray(d.photo)?d.photo:[d.photo];
      for(const src of photos.slice(0,3)){
        if(!src||photoCache.has(src))continue;
        photoPromises.push(new Promise(resolve=>{
          const img=new Image();
          img.onload=()=>{photoCache.set(src,img);resolve();};
          img.onerror=()=>{photoCache.set(src,null);resolve();};
          img.src=src;
        }));
      }
    }
    await Promise.all(photoPromises);
  }

  // ── Preload static maps for map-pinned entries ─────────────────
  const mapImgCache=new Map(); // keyed by defect.id
  if(mapDefects.length>0){
    if(typeof onProgress==="function")onProgress(`Fetching ${mapDefects.length} map thumbnails…`);
    const mapPromises=mapDefects.map(async d=>{
      const z=d.mapZoom||17;
      const color=SEV_COLOR[d.severity]||"#ff6b00";
      let src;
      if(mapProvider==="gmaps"&&gmapsKey){
        src=staticMapUrl("gmaps",d.lat,d.lng,z,"600x240");
      }else{
        try{src=await _renderOsmComposite(d.lat,d.lng,z,600,240,[{lat:d.lat,lng:d.lng,color}]);}
        catch{src=null;}
      }
      if(!src){mapImgCache.set(d.id,null);return;}
      await new Promise(resolve=>{
        const img=new Image();img.crossOrigin="anonymous";
        img.onload=()=>{mapImgCache.set(d.id,img);resolve();};
        img.onerror=()=>{mapImgCache.set(d.id,null);resolve();};
        img.src=src;
      });
    });
    await Promise.all(mapPromises);
  }
  if(defects&&defects.length>0){
    heading("ENTRY DETAILS",orange);
    for(let idx=0;idx<defects.length;idx++){
      const d=defects[idx];
      const hasPhoto=d.photo&&(typeof d.photo==="string"||(Array.isArray(d.photo)&&d.photo.length>0));
      const comments=(d.comments||[]).filter(c=>c.text);
      // Estimate block height: header(20) + fields(30) + photo(~70) + desc(15) + comments(comments*8) + padding
      const estH=30+(hasPhoto?75:0)+(d.description?15:0)+(comments.length>0?10+comments.length*7:0)+10;
      checkPage(Math.min(estH,120));

      // ── Card border + severity accent ──
      const cardTop=y;
      const cardPage=doc.internal.getNumberOfPages();
      const sevColor=sevRGB[d.severity]||[100,100,100];

      // Entry number + title
      doc.setFontSize(11);doc.setFont(undefined,"bold");doc.setTextColor(26);
      const idStr=d.defect_id||`#${idx+1}`;
      const titleFull=`${idStr}  ${d.title||"Untitled"}`;
      const titleLines=doc.splitTextToSize(titleFull,contentW-4);
      doc.text(titleLines[0],margin+1,y+1);
      if(titleLines.length>1){doc.setFontSize(9);doc.text(titleLines[1],margin+1,y+5.5);y+=10;}
      else y+=6;

      // Badges row: type + severity + status
      let bx2=margin+1;
      if(d.entryType){
        const typeRGB={Defect:[255,59,48],Observation:[52,170,220],Update:[255,149,0],Instruction:[88,86,214]};
        bx2+=badge(d.entryType.toUpperCase(),bx2,y+3,typeRGB[d.entryType]||[100,100,100])+3;
      }
      if(d.severity)bx2+=badge(d.severity.toUpperCase(),bx2,y+3,sevColor)+3;
      if(d.status){
        const stRGB=statRGB[d.status]||[100,100,100];
        bx2+=badge(d.status.toUpperCase(),bx2,y+3,stRGB)+3;
      }
      // Overdue badge
      if(d.dueDate&&new Date(d.dueDate)<now&&!["Verified","Closed"].includes(d.status)){
        badge("OVERDUE",bx2,y+3,[200,0,0]);
      }
      y+=8;

      // ── Fields grid (2 columns) ──
      const col1=margin+1,col2=margin+contentW*0.5;
      const fw=contentW*0.45;
      field("Location",d.location,col1,y,fw);
      field("Assigned To",d.assignee,col2,y,fw);y+=9;
      field("Trade",d.component||d.trade,col1,y,fw);
      field("Logged By",`${d.loggedBy||"—"}${d.loggedByRole?" ("+d.loggedByRole+")":""}`,col2,y,fw);y+=9;
      field("Date",fmtDate(d.createdAt||d.created),col1,y,fw);
      field("Due Date",d.dueDate?fmtDate(d.dueDate):"—",col2,y,fw);y+=9;
      // Cost row (if present)
      if(d.costImpact||d.costAmount||d.costResponsible){
        field("Cost Impact",d.costImpact,col1,y,fw);
        field("Cost Amount",d.costAmount?`$${d.costAmount}`:"—",col2,y,fw);y+=9;
        field("Cost Responsible",d.costResponsible,col1,y,fw);
        if(d.costRemarks)field("Cost Remarks",d.costRemarks,col2,y,fw);
        y+=9;
      }
      if(d.duration){field("Duration",d.duration,col1,y,fw);y+=9;}

      // ── Photo inline ──
      if(hasPhoto){
        const photos=Array.isArray(d.photo)?d.photo:[d.photo];
        const validPhotos=photos.slice(0,3).filter(Boolean);
        if(validPhotos.length===1){
          // Single photo — full width
          const img=photoCache.get(validPhotos[0]);
          if(img&&img.width>0&&img.height>0){
            checkPage(65);
            const ratio=img.height/img.width;
            const imgW=contentW*0.65;
            const imgH=Math.min(imgW*ratio,60);
            try{doc.addImage(validPhotos[0],"JPEG",margin+1,y,imgW,imgH);}catch(e){/* skip */}
            y+=imgH+3;
          }
        }else if(validPhotos.length>1){
          // Multiple photos — side by side
          checkPage(65);
          const gap=4;
          const imgW=(contentW-gap*(validPhotos.length-1))/validPhotos.length;
          let maxH=0;
          for(let pi=0;pi<validPhotos.length;pi++){
            const img=photoCache.get(validPhotos[pi]);
            if(img&&img.width>0&&img.height>0){
              const ratio=img.height/img.width;
              const imgH=Math.min(imgW*ratio,60);
              try{doc.addImage(validPhotos[pi],"JPEG",margin+1+pi*(imgW+gap),y,imgW,imgH);}catch(e){/* skip */}
              if(imgH>maxH)maxH=imgH;
            }
          }
          y+=maxH+3;
        }
        y+=2;
      }

      // ── Description ──
      if(d.description){
        checkPage(12);
        doc.setFillColor(248,248,246);doc.roundedRect(margin+1,y-1,contentW-2,0.5,0,0,"F");// subtle divider
        y+=2;
        doc.setFontSize(6.5);doc.setFont(undefined,"bold");doc.setTextColor(140);
        doc.text("DESCRIPTION",margin+1,y);y+=3.5;
        doc.setFontSize(8);doc.setFont(undefined,"normal");doc.setTextColor(60);
        const descLines=doc.splitTextToSize(d.description,contentW-4);
        for(const line of descLines.slice(0,6)){// max 6 lines
          doc.text(line,margin+1,y);y+=3.5;
        }
        if(descLines.length>6){doc.setTextColor(140);doc.text("...",margin+1,y);y+=3.5;}
        doc.setTextColor(0);y+=2;
      }

      // ── Comments timeline ──
      if(comments.length>0){
        checkPage(10+comments.length*6);
        doc.setFontSize(6.5);doc.setFont(undefined,"bold");doc.setTextColor(140);
        doc.text(`COMMENTS (${comments.length})`,margin+1,y);y+=4;
        for(const c of comments.slice(0,8)){// max 8 comments
          checkPage(8);
          doc.setFontSize(7);doc.setFont(undefined,"bold");doc.setTextColor(255,107,0);
          const cDate=c.created?new Date(c.created).toLocaleDateString("en-GB",{day:"numeric",month:"short"}):"";
          doc.text(`${c.author||"User"} ${cDate?("("+cDate+")"):""}`,margin+3,y);
          doc.setFont(undefined,"normal");doc.setTextColor(60);
          const cLines=doc.splitTextToSize(c.text,contentW-8);
          doc.text(cLines[0],margin+3,y+3.5);
          y+=8;
        }
        if(comments.length>8){doc.setFontSize(6);doc.setTextColor(140);doc.text(`+ ${comments.length-8} more comments`,margin+3,y);y+=4;}
        doc.setTextColor(0);
      }

      // ── Map thumbnail (if entry has GPS coords) ──
      const mapImg=mapImgCache.get(d.id);
      if(mapImg&&mapImg.width>0){
        const mw=contentW-2;
        const mh=mw*(mapImg.height/mapImg.width);
        checkPage(mh+8);
        doc.setFontSize(6.5);doc.setFont(undefined,"bold");doc.setTextColor(140);
        doc.text(`🗺 MAP LOCATION  ·  ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`,margin+1,y);
        doc.setTextColor(0);y+=2;
        try{doc.addImage(mapImg,"PNG",margin+1,y,mw,mh);}catch{}
        y+=mh+3;
      }

      // ── Card bottom border ──
      y+=3;
      doc.setDrawColor(230);doc.setLineWidth(0.3);
      doc.line(margin,y,margin+contentW,y);
      doc.setDrawColor(0);
      y+=6;

      // Severity accent left border — only if card stayed on same page
      if(doc.internal.getNumberOfPages()===cardPage){
        doc.setFillColor(sevColor[0],sevColor[1],sevColor[2]);
        doc.rect(margin-1,cardTop-3,1.5,y-cardTop-1,"F");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DRAWING ANNOTATIONS
  // ═══════════════════════════════════════════════════════════════════
  if(drawings&&drawings.length>0){
    const annotated=drawings.filter(d=>{
      const n=getDrawingNotes(d.id)||[];
      const m=getDrawingMarkup(d.id)||[];
      const p=(allPins||[]).filter(pin=>pin.drawingId===d.id);
      return n.length>0||m.length>0||p.length>0;
    });
    if(annotated.length>0){
      doc.addPage();y=18;
      heading("DRAWING ANNOTATIONS",orange);
      const dHeaders=[["Drawing","Pins","Notes","Markups"]];
      const dRows=annotated.map(d=>[
        d.name||"",
        String((allPins||[]).filter(p=>p.drawingId===d.id).length),
        String((getDrawingNotes(d.id)||[]).length),
        String((getDrawingMarkup(d.id)||[]).length)
      ]);
      doc.autoTable({startY:y,head:dHeaders,body:dRows,margin:{left:margin,right:margin},styles:{fontSize:8,cellPadding:2},headStyles:{fillColor:orange,textColor:255,fontStyle:"bold"}});
      y=doc.lastAutoTable.finalY+8;

      let drawingIdx=0;
      for(const d of annotated){
        drawingIdx++;
        try{
          if(typeof onProgress==="function")onProgress(`Rendering drawing ${drawingIdx}/${annotated.length}…`);
          const pages=await renderDrawingAnnotatedPages(d,(allDefectsForPins&&allDefectsForPins.length?allDefectsForPins:defects),allPins||[]);
          if(!pages||pages.length===0)continue;
          for(const pg of pages){
            doc.addPage();y=18;
            doc.setFontSize(11);doc.setFont(undefined,"bold");doc.setTextColor(255,107,0);
            doc.text(`${d.name||"Drawing"}${pages.length>1?" — Page "+pg.pageNum:""}`,margin,y);
            doc.setTextColor(0);y+=6;
            doc.setFontSize(8);doc.setFont(undefined,"normal");
            const notes=getDrawingNotes(d.id)||[];const markups=getDrawingMarkup(d.id)||[];
            const drawingPins=(allPins||[]).filter(p=>p.drawingId===d.id);
            doc.text(`${drawingPins.length} pin(s), ${notes.length} note(s), ${markups.length} markup(s)`,margin,y);y+=6;
            const img=new Image();
            await new Promise((resolve)=>{img.onload=resolve;img.onerror=resolve;img.src=pg.dataUrl;});
            if(img.width>0&&img.height>0){
              const ratio=img.height/img.width;
              const imgW=contentW;
              const imgH=Math.min(imgW*ratio,pageH-y-margin-10);
              const actualW=imgH/(ratio||1);
              doc.addImage(pg.dataUrl,"JPEG",margin,y,Math.min(imgW,actualW),imgH);
              y+=imgH+4;
            }
          }
        }catch(e){console.warn("exportReportPdf: failed to render drawing",d.name,e);}
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SAVED COMPARISONS
  // ═══════════════════════════════════════════════════════════════════
  if(savedComparisons&&savedComparisons.length>0){
    doc.addPage();y=18;
    heading("SAVED COMPARISONS",purple);
    const cHeaders=[["Base","Target","Added","Removed","AI Report","Date"]];
    const cRows=savedComparisons.map(sc=>[sc.baseName||"",sc.targetName||"","+"+String(sc.totalAdded||0),"-"+String(sc.totalRemoved||0),sc.aiReport?"Yes":"No",fmtDate(sc.savedAt)]);
    doc.autoTable({startY:y,head:cHeaders,body:cRows,margin:{left:margin,right:margin},styles:{fontSize:8,cellPadding:2},headStyles:{fillColor:purple,textColor:255,fontStyle:"bold"}});
    y=doc.lastAutoTable.finalY+8;
    for(const sc of savedComparisons){
      if(!sc.overlayThumb)continue;
      try{
        const img=new Image();
        await new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;img.src=sc.overlayThumb;});
        if(img.width>0&&img.height>0){
          doc.addPage();y=18;
          doc.setFontSize(11);doc.setFont(undefined,"bold");doc.setTextColor(88,86,214);
          doc.text(`${sc.baseName||"Base"} vs ${sc.targetName||"Target"}`,margin,y);
          doc.setTextColor(0);y+=6;
          doc.setFontSize(8);doc.setFont(undefined,"normal");
          doc.text(`+${sc.totalAdded||0} added, -${sc.totalRemoved||0} removed${sc.savedAt?" · "+fmtDate(sc.savedAt):""}`,margin,y);y+=6;
          const ratio=img.height/img.width;
          const imgW=contentW;
          const imgH=Math.min(imgW*ratio,pageH-y-margin-10);
          const actualW=imgH/(ratio||1);
          doc.addImage(sc.overlayThumb,"JPEG",margin,y,Math.min(imgW,actualW),imgH);
          y+=imgH+4;
          if(sc.aiReport){
            y+=4;doc.setFontSize(9);doc.setFont(undefined,"bold");doc.text("AI Diff Report:",margin,y);y+=5;
            doc.setFont(undefined,"normal");doc.setFontSize(8);
            const rptLines=doc.splitTextToSize(sc.aiReport,contentW);
            for(const rl of rptLines){if(y>pageH-15){doc.addPage();y=18;}doc.text(rl,margin,y);y+=3.8;}
          }
        }
      }catch(e){console.warn("PDF: failed to embed comparison overlay",e);}
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAP OVERVIEW — all GPS-pinned entries on one static map
  // ═══════════════════════════════════════════════════════════════════
  if(mapDefects.length>0){
    if(typeof onProgress==="function")onProgress("Fetching overview map…");
    // Compute bounding-box centre for OSM fallback (since OSM staticmap.openstreetmap.de
    // doesn't accept multi-marker colour groups cleanly, we center + show first 20 pins)
    const lats=mapDefects.map(d=>d.lat),lngs=mapDefects.map(d=>d.lng);
    const centerLat=(Math.min(...lats)+Math.max(...lats))/2;
    const centerLng=(Math.min(...lngs)+Math.max(...lngs))/2;
    let overviewSrc;
    if(mapProvider==="gmaps"&&gmapsKey){
      const bySev={Critical:"red",Major:"orange",Minor:"yellow",Observation:"blue"};
      const groups={};
      for(const d of mapDefects){
        const c=bySev[d.severity]||"gray";
        (groups[c]||(groups[c]=[])).push(`${d.lat},${d.lng}`);
      }
      const markerParams=Object.entries(groups).map(([color,pts])=>
        `markers=color:${color}%7C${pts.slice(0,40).join("%7C")}`
      ).join("&");
      overviewSrc=`https://maps.googleapis.com/maps/api/staticmap?size=640x480&maptype=hybrid&${markerParams}&key=${encodeURIComponent(gmapsKey)}`;
    }else{
      const minLat=Math.min(...lats),maxLat=Math.max(...lats);
      const minLng=Math.min(...lngs),maxLng=Math.max(...lngs);
      const W=640,H=480;
      const zoom=mapDefects.length===1?16:_osmZoomForBounds(minLat,maxLat,minLng,maxLng,W,H);
      const markers=mapDefects.map((d,i)=>({lat:d.lat,lng:d.lng,color:SEV_COLOR[d.severity]||"#8e8e93",label:d.defect_id||(i+1)}));
      try{overviewSrc=await _renderOsmComposite(centerLat,centerLng,zoom,W,H,markers);}
      catch{overviewSrc=null;}
    }
    const overviewImg=overviewSrc?await new Promise(resolve=>{
      const img=new Image();img.crossOrigin="anonymous";
      img.onload=()=>resolve(img);img.onerror=()=>resolve(null);
      img.src=overviewSrc;
    }):null;
    doc.addPage();y=18;
    heading("ALL PINS ON MAP",orange);
    if(overviewImg){
      const ow=contentW;
      const oh=ow*(overviewImg.height/overviewImg.width);
      try{doc.addImage(overviewImg,"PNG",margin,y,ow,oh);}catch{}
      y+=oh+4;
    }
    // Legend + summary
    doc.setFontSize(8);doc.setFont(undefined,"bold");doc.setTextColor(60);
    doc.text(`${mapDefects.length} map-pinned entries`,margin,y);y+=5;
    doc.setFont(undefined,"normal");doc.setTextColor(80);
    const legend=[
      ["Critical",sevRGB.Critical],
      ["Major",sevRGB.Major],
      ["Minor",sevRGB.Minor],
      ["Observation",sevRGB.Observation],
    ];
    let lx=margin;
    for(const[lbl,rgb]of legend){
      const cnt=mapDefects.filter(d=>d.severity===lbl).length;
      if(cnt===0)continue;
      doc.setFillColor(rgb[0],rgb[1],rgb[2]);doc.circle(lx+1.5,y-1,1.4,"F");
      doc.setTextColor(60);doc.text(`${lbl} (${cnt})`,lx+4,y);
      lx+=30;
    }
    y+=6;
    // Per-pin table
    const mHeaders=[["#","Title","Severity","Lat","Lng"]];
    const mRows=mapDefects.map((d,i)=>[
      d.defect_id||String(i+1),
      (d.title||"").substring(0,60),
      d.severity||"",
      d.lat.toFixed(6),
      d.lng.toFixed(6),
    ]);
    doc.autoTable({startY:y,head:mHeaders,body:mRows,margin:{left:margin,right:margin},
      styles:{fontSize:7,cellPadding:1.8},headStyles:{fillColor:orange,textColor:255,fontStyle:"bold"},
      alternateRowStyles:{fillColor:[252,250,247]},
      columnStyles:{0:{cellWidth:14},1:{cellWidth:70},2:{cellWidth:22},3:{cellWidth:30},4:{cellWidth:30}},
      didParseCell:(data)=>{if(data.section==="body"&&data.column.index===2){const rgb=sevRGB[data.cell.raw];if(rgb)data.cell.styles.textColor=rgb;data.cell.styles.fontStyle="bold";}}
    });
    y=doc.lastAutoTable.finalY+6;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONTRACT ADVISORY
  // ═══════════════════════════════════════════════════════════════════
  if(contractAdvisory){
    doc.addPage();y=18;
    heading("CONTRACT CLAUSE ADVISORY",purple);
    doc.setFontSize(9);doc.setFont(undefined,"normal");doc.setTextColor(0);
    const lines=doc.splitTextToSize(contractAdvisory,contentW);
    for(const line of lines){
      if(y>pageH-15){doc.addPage();y=18;}
      doc.text(line,margin,y);y+=4.2;
    }
    y+=4;checkPage(20);
    doc.setFontSize(7);doc.setTextColor(150);
    const disc="Disclaimer: This advisory is generated by AI for reference only. It is not legal advice. Always verify clause references against your actual contract documents and consult qualified professionals before acting on contractual matters.";
    const discLines=doc.splitTextToSize(disc,contentW);
    for(const dl of discLines){doc.text(dl,margin,y);y+=3.5;}
    doc.setTextColor(0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PAGE NUMBERS — "Page X of Y" + footer on all pages
  // ═══════════════════════════════════════════════════════════════════
  const totalPages=doc.internal.getNumberOfPages();
  for(let i=1;i<=totalPages;i++){
    doc.setPage(i);
    doc.setFontSize(7);doc.setFont(undefined,"normal");doc.setTextColor(160);
    doc.text(`Page ${i} of ${totalPages}`,pageW-margin,pageH-7,{align:"right"});
    // Left footer: company + project
    doc.text(`${companyName||"SiteShrimp"} — ${projectName||"Report"}`,margin,pageH-7);
    // Subtle top line on pages after cover
    if(i>1){
      doc.setDrawColor(230);doc.setLineWidth(0.3);
      doc.line(margin,10,pageW-margin,10);doc.setDrawColor(0);
    }
    doc.setTextColor(0);
  }

  if(typeof onProgress==="function")onProgress("Saving PDF…");
  doc.save(`SiteShrimp_Report_${(projectName||"Export").replace(/\s/g,"_")}_${now.toLocaleDateString("en-GB").replace(/\//g,"-")}.pdf`);
}

// ── Google Sheets Export ───────────────────────────────────────────
// Uses Google Sheets API v4 with OAuth2 access token
// User provides their own Google Client ID (self-hosted)

const GSHEET_KEY="sdt-gsheet-v1";
let _gsheetToken=null;

function getGSheetConfig(){return JSON.parse(localStorage.getItem(GSHEET_KEY)||"null");}
function saveGSheetConfig(cfg){localStorage.setItem(GSHEET_KEY,JSON.stringify(cfg));}

async function gsheetAuth(clientId){
  return new Promise((resolve,reject)=>{
    if(!window.google?.accounts?.oauth2){
      // Load Google Identity Services script dynamically
      const s=document.createElement("script");
      s.src="https://accounts.google.com/gsi/client";
      s.onload=()=>doAuth();
      s.onerror=()=>reject(new Error("Failed to load Google auth"));
      document.head.appendChild(s);
    }else doAuth();
    function doAuth(){
      const client=google.accounts.oauth2.initTokenClient({
        client_id:clientId,
        scope:"https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
        callback:(resp)=>{
          if(resp.error)reject(new Error(resp.error));
          else{_gsheetToken=resp.access_token;resolve(resp.access_token);}
        }
      });
      client.requestAccessToken();
    }
  });
}

async function exportToGoogleSheets(defects,projectName,companyName){
  const cfg=getGSheetConfig();
  if(!cfg?.clientId)throw new Error("Google Sheets not configured. Set up Client ID in Settings.");
  // Auth
  if(!_gsheetToken)await gsheetAuth(cfg.clientId);
  const token=_gsheetToken;
  const headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"};

  // Prepare data rows
  const fmtDate=d=>d?new Date(d).toLocaleDateString("en-GB"):"";
  const headerRow=["ID","Type","Title","Location","Severity","Status","Assignee","Trade","Logged By","Date","Due Date","Duration","Cost Impact","Cost Amount","Cost Responsible","Description","Comments"];
  const dataRows=defects.map(d=>[
    d.defect_id||d.id||"",
    d.entryType||"Defect",
    d.title||"",
    d.location||"",
    d.severity||"",
    d.status||"",
    d.assignee||"",
    d.component||d.trade||"",
    d.loggedBy||"",
    fmtDate(d.createdAt||d.created),
    fmtDate(d.dueDate),
    d.duration||"",
    d.costImpact||"",
    d.costAmount||"",
    d.costResponsible||"",
    d.description||"",
    (d.comments||[]).map(c=>`${c.author||""}: ${c.text||""}`).join(" | ")
  ]);

  // Summary rows
  const total=defects.length;
  const bySev={};defects.forEach(d=>{bySev[d.severity]=(bySev[d.severity]||0)+1;});
  const byStat={};defects.forEach(d=>{byStat[d.status]=(byStat[d.status]||0)+1;});
  const overdue=defects.filter(d=>d.dueDate&&new Date(d.dueDate)<new Date()&&!["Verified","Closed"].includes(d.status)).length;
  const withCost=defects.filter(d=>d.costAmount&&String(d.costAmount).trim());
  const totalCost=withCost.reduce((s,d)=>s+(parseFloat(String(d.costAmount).replace(/[^0-9.\-]/g,""))||0),0);

  const summaryRows=[
    ["SITE REPORT — "+new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})],
    [companyName||"","Project: "+(projectName||"")],
    [],
    ["SUMMARY"],
    ["Total Entries",total,"Overdue",overdue],
    ["By Severity",...SEVERITY.map(s=>`${s}: ${bySev[s]||0}`)],
    ["By Status",...STATUS.map(s=>`${s}: ${byStat[s]||0}`)],
    ...(totalCost>0?[["Total Cost Impact","$"+totalCost.toLocaleString("en",{minimumFractionDigits:2}),`${withCost.length} entries with cost`]]:[]),
    [],
    headerRow,
    ...dataRows
  ];

  // Create or update spreadsheet
  let spreadsheetId=cfg.spreadsheetId;
  const sheetTitle=`${projectName||"Report"} — ${new Date().toLocaleDateString("en-GB")}`;

  if(!spreadsheetId){
    // Create new spreadsheet
    const createResp=await fetch("https://sheets.googleapis.com/v4/spreadsheets",{
      method:"POST",headers,
      body:JSON.stringify({
        properties:{title:`SiteShrimp — ${projectName||"Report"}`},
        sheets:[{properties:{title:sheetTitle}}]
      })
    });
    if(!createResp.ok){const e=await createResp.json();throw new Error(e.error?.message||"Failed to create spreadsheet");}
    const created=await createResp.json();
    spreadsheetId=created.spreadsheetId;
    saveGSheetConfig({...cfg,spreadsheetId});
  }else{
    // Add new sheet tab for this export
    try{
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,{
        method:"POST",headers,
        body:JSON.stringify({requests:[{addSheet:{properties:{title:sheetTitle}}}]})
      });
    }catch(e){/* sheet name may already exist, will overwrite */}
  }

  // Write data
  const writeResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${encodeURIComponent(sheetTitle)}'!A1?valueInputOption=USER_ENTERED`,{
    method:"PUT",headers,
    body:JSON.stringify({range:`'${sheetTitle}'!A1`,majorDimension:"ROWS",values:summaryRows})
  });
  if(!writeResp.ok){const e=await writeResp.json();throw new Error(e.error?.message||"Failed to write data");}

  // Format header row — bold + orange background
  // Find header row index (summary rows before data)
  const headerRowIdx=summaryRows.indexOf(headerRow);
  try{
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,{
      method:"POST",headers,
      body:JSON.stringify({requests:[
        // Bold + orange header row
        {repeatCell:{range:{sheetId:0,startRowIndex:headerRowIdx,endRowIndex:headerRowIdx+1,startColumnIndex:0,endColumnIndex:headerRow.length},
          cell:{userEnteredFormat:{backgroundColor:{red:1,green:0.42,blue:0},textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}}},
          fields:"userEnteredFormat(backgroundColor,textFormat)"}},
        // Bold title row
        {repeatCell:{range:{sheetId:0,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:1},
          cell:{userEnteredFormat:{textFormat:{bold:true,fontSize:14}}},
          fields:"userEnteredFormat(textFormat)"}},
        // Auto-resize columns
        {autoResizeDimensions:{dimensions:{sheetId:0,dimension:"COLUMNS",startIndex:0,endIndex:headerRow.length}}}
      ]})
    });
  }catch(e){/* formatting is optional, data is already written */}

  return{spreadsheetId,url:`https://docs.google.com/spreadsheets/d/${spreadsheetId}`};
}

async function sendTelegram(token,chatId,text){
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML"})
    });
    return r.ok;
  }catch{return false;}
}

async function sendTelegramPhoto(token,chatId,base64DataUrl,caption){
  try{
    const blob=await fetch(base64DataUrl).then(r=>r.blob());
    const form=new FormData();
    form.append("chat_id",chatId);
    form.append("photo",blob,"defect.jpg");
    form.append("caption",caption);
    form.append("parse_mode","HTML");
    return (await fetch(`https://api.telegram.org/bot${token}/sendPhoto`,{method:"POST",body:form})).ok;
  }catch{return false;}
}

function generateEmailHTML(defects,projectName,companyName,opts={}){
  const total=defects.length;
  const open=defects.filter(d=>d.status==="Open").length;
  const inProg=defects.filter(d=>d.status==="In Progress").length;
  const done=defects.filter(d=>d.status==="Done").length;
  const verified=defects.filter(d=>d.status==="Verified").length;
  const closed=defects.filter(d=>d.status==="Closed").length;
  const critical=defects.filter(d=>d.severity==="Critical"&&!["Verified","Closed"].includes(d.status)).length;
  const date=new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});

  // Entry type summary
  const typeCounts={};
  defects.forEach(d=>{const t=d.entryType||"Defect";typeCounts[t]=(typeCounts[t]||0)+1;});
  const typeSummary=Object.entries(typeCounts).map(([t,c])=>`<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:bold;color:${typeColor(t)};background:${typeBg(t)}">${typeIcon(t)} ${tOpt(t)} (${c})</span>`).join("");

  const row=(label,val)=>val?`<tr><td style="padding:2px 8px 2px 0;color:#999;white-space:nowrap;vertical-align:top">${label}</td><td>${val}</td></tr>`:"";

  const defectRows=defects.map(d=>{
    const dt=(d.createdAt||d.created)?new Date(d.createdAt||d.created).toLocaleDateString("en-GB"):"—";
    const entryTypeBadge=d.entryType?`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${typeColor(d.entryType)};background:${typeBg(d.entryType)};margin-right:6px">${typeIcon(d.entryType)} ${tOpt(d.entryType)}</span>`:"";
    const sevBadge=`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${SEV_COLOR[d.severity]};background:${SEV_BG[d.severity]}">${SEV_I18N[d.severity]?t(SEV_I18N[d.severity]):d.severity}</span>`;
    const statusBadge=`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${STATUS_COLOR[d.status]||"#8e8e93"};background:rgba(0,0,0,0.06)">${STATUS_I18N[d.status]?t(STATUS_I18N[d.status]):d.status}</span>`;
    const comments=(d.comments||[]).map(c=>`<div style="padding:6px 10px;background:#f5f5f5;border-radius:6px;font-size:12px;margin:4px 0"><b style="color:#ff6b00">${sanitize(c.by)}:</b> ${sanitize(c.text)}</div>`).join("");
    const photoNote=d.photo?`<div style="font-size:11px;color:#888;font-style:italic;margin-top:6px;padding:6px 8px;background:#f5f5f5;border-radius:6px">📷 ${Array.isArray(d.photo)?d.photo.length:1} photo(s) — view in SiteShrimp app</div>`:"";

    return `<div style="margin-bottom:14px;padding:14px;border:1px solid #e5e5e5;border-radius:10px;border-left:5px solid ${SEV_COLOR[d.severity]}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">${entryTypeBadge}${sevBadge}${statusBadge}${d.defect_id?`<span style="font-size:10px;color:#aaa;margin-left:auto">${d.defect_id}</span>`:""}</div>
      <div style="font-size:15px;font-weight:bold;margin-bottom:8px">${sanitize(d.title)||"—"}</div>
      <table style="font-size:12px;color:#555;margin-bottom:6px"><tbody>
        ${row("📍 Location",d.location)}
        ${row("👤 Assigned",d.assignee)}
        ${row("🔧 "+t("fields.component"),d.component?(tOpt(d.component)+(d.issue?" — "+tOpt(d.issue):"")):"") }
        ${row("🏗 "+t("fields.trade"),d.trade?tOpt(d.trade):"")}
        ${row("✍️ "+t("fields.logged_by"),d.loggedBy?(d.loggedBy+(d.loggedByRole?" ("+d.loggedByRole+")":"")):"") }
        ${row("📅 "+t("fields.date"),dt)}
        ${row("⏰ "+t("fields.due_date"),d.dueDate)}
        ${row("⏱ "+t("fields.duration"),d.duration?tOpt(d.duration):"")}
        ${row("💰 "+t("fields.cost_impact"),d.costImpact?(tOpt(d.costImpact)+(d.costAmount?" — $"+d.costAmount:"")):"") }
        ${row("📋 "+t("fields.cost_responsible"),d.costResponsible?tOpt(d.costResponsible):"")}
      </tbody></table>
      ${d.description?`<div style="font-size:13px;color:#444;padding:8px;background:#f9f9f9;border-radius:6px;margin-bottom:6px">${sanitize(d.description)}</div>`:""}
      ${photoNote}
      ${comments?`<div style="margin-top:8px"><div style="font-size:10px;font-weight:bold;color:#999;margin-bottom:4px">COMMENTS (${(d.comments||[]).length})</div>${comments}</div>`:""}
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f5f5f5">
    <div style="background:#1a1a1a;padding:22px;border-radius:12px;margin-bottom:16px">
      <div style="color:#ff6b00;font-weight:bold;font-size:10px;letter-spacing:3px">SITESHRIMP · ${companyName||""}</div>
      <div style="color:#fff;font-size:24px;font-weight:bold;margin-top:4px">${projectName||"SITE"} REPORT</div>
      <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:2px">${date}</div>
    </div>
    <div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px;text-align:center">
      <table style="width:100%"><tr>
        <td><div style="font-size:28px;font-weight:bold">${total}</div><div style="font-size:10px;color:#999">TOTAL</div></td>
        <td><div style="font-size:28px;font-weight:bold;color:#ff3b30">${open}</div><div style="font-size:10px;color:#999">OPEN</div></td>
        <td><div style="font-size:28px;font-weight:bold;color:#ff9500">${inProg}</div><div style="font-size:10px;color:#999">IN PROG</div></td>
        <td><div style="font-size:28px;font-weight:bold;color:#34aadc">${done}</div><div style="font-size:10px;color:#999">DONE</div></td>
        <td><div style="font-size:28px;font-weight:bold;color:#30d158">${verified}</div><div style="font-size:10px;color:#999">VERIFIED</div></td>
        <td><div style="font-size:28px;font-weight:bold;color:#8e8e93">${closed}</div><div style="font-size:10px;color:#999">CLOSED</div></td>
      </tr></table>
    </div>
    ${critical>0?`<div style="background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);border-radius:12px;padding:14px;margin-bottom:14px;text-align:center"><div style="font-size:18px;font-weight:bold;color:#ff3b30">⚠️ ${critical} CRITICAL UNRESOLVED</div><div style="font-size:12px;color:#888">Requires immediate attention</div></div>`:""}
    ${typeSummary?`<div style="background:#fff;padding:14px;border-radius:12px;margin-bottom:14px;text-align:center"><div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:8px">BY TYPE</div>${typeSummary}</div>`:""}
    <div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:12px">ALL ENTRIES (${total})</div>
      ${defectRows||'<div style="color:#999;text-align:center;padding:16px">No entries found.</div>'}
    </div>
    ${opts.drawingsHtml||""}
    ${opts.comparisonsHtml||""}
    <div style="text-align:center;color:#aaa;font-size:11px;padding:12px">SiteShrimp v2 · ${date}</div>
  </body></html>`;
}

function generateDrawingsEmailHTML(drawings,allPins,allDefects){
  if(!drawings||!drawings.length)return"";
  const pinsAll=allPins||[];
  const defectsAll=allDefects||[];
  let html=`<div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px"><div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:12px">📐 DRAWING ANNOTATIONS</div>`;
  drawings.forEach(d=>{
    const notes=getDrawingNotes(d.id);
    const markups=getDrawingMarkup(d.id);
    const dPins=pinsAll.filter(p=>p.drawingId===d.id);
    const total=notes.length+markups.length+dPins.length;
    if(total===0)return;
    html+=`<div style="margin-bottom:12px;padding:12px;border:1px solid #e5e5e5;border-radius:8px;border-left:4px solid #ff6b00"><div style="font-weight:bold;font-size:13px;margin-bottom:6px">${sanitize(d.name)} <span style="color:#999;font-weight:normal;font-size:11px">(${total} annotation${total>1?"s":""})</span></div>`;
    dPins.forEach(p=>{
      const df=defectsAll.find(x=>x.id===p.entryId);
      const sev=df?.severity||"—";
      const sevColor=SEV_COLOR&&SEV_COLOR[sev]?SEV_COLOR[sev]:"#ff3b30";
      html+=`<div style="font-size:12px;padding:4px 8px;margin:3px 0;background:#fff3f3;border-radius:4px"><span style="color:${sevColor};font-weight:bold">PIN:</span> ${sanitize(df?.title||"Linked entry")} <span style="color:#999;font-size:10px">— ${sanitize(sev)}${df?.status?" · "+sanitize(df.status):""}</span></div>`;
    });
    notes.forEach(n=>{html+=`<div style="font-size:12px;padding:4px 8px;margin:3px 0;background:#f5f3ff;border-radius:4px"><span style="color:#5856d6;font-weight:bold">NOTE:</span> ${sanitize(n.text)} <span style="color:#999;font-size:10px">— ${sanitize(n.createdBy||"")}</span></div>`;});
    markups.filter(s=>s.type==="text"&&s.text).forEach(s=>{html+=`<div style="font-size:12px;padding:4px 8px;margin:3px 0;background:#fff8f3;border-radius:4px"><span style="color:#ff6b00;font-weight:bold">MARKUP:</span> ${sanitize(s.text)}</div>`;});
    const nonText=markups.filter(s=>s.type!=="text");
    if(nonText.length)html+=`<div style="font-size:11px;color:#999;margin-top:4px">${nonText.length} graphical annotation(s): ${nonText.filter(s=>s.type==="freehand").length} freehand, ${nonText.filter(s=>s.type==="arrow").length} arrow, ${nonText.filter(s=>s.type==="circle").length} circle</div>`;
    html+=`</div>`;
  });
  html+=`</div>`;
  return html;
}

function generateComparisonsEmailHTML(comparisons){
  if(!comparisons||!comparisons.length)return"";
  let html=`<div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px"><div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:12px">🔍 SAVED COMPARISONS</div>`;
  comparisons.forEach(sc=>{
    html+=`<div style="margin-bottom:12px;padding:12px;border:1px solid #e5e5e5;border-radius:8px;border-left:4px solid #5856d6"><div style="font-weight:bold;font-size:13px;margin-bottom:6px">${sanitize(sc.baseName)} → ${sanitize(sc.targetName)}</div>`;
    html+=`<div style="display:flex;gap:10px;margin-bottom:6px"><span style="color:#ff3b30;font-weight:bold;font-size:12px">+${sc.totalAdded||0} added</span><span style="color:#34c759;font-weight:bold;font-size:12px">-${sc.totalRemoved||0} removed</span></div>`;
    if(sc.aiReport)html+=`<div style="font-size:11px;background:#f5f3ff;border:1px solid #d8d2ff;border-radius:6px;padding:8px;margin:6px 0;white-space:pre-wrap">${sanitize(sc.aiReport)}</div><div style="font-size:10px;color:${sc.aiLocked?"#1a7a35":"#888"};margin-bottom:4px">Status: ${sc.aiLocked?"APPROVED":"DRAFT"}</div>`;
    (sc.markups||[]).filter(s=>s.type==="text"&&s.text).forEach(s=>{html+=`<div style="font-size:11px;padding:3px 8px;margin:2px 0;background:#fff8f3;border-radius:4px"><span style="color:#ff6b00;font-weight:bold">📝</span> ${sanitize(s.text)}</div>`;});
    html+=`</div>`;
  });
  html+=`</div>`;
  return html;
}

// ── UI Helpers ────────────────────────────────────────────────────
function useVoice(){
  const[listening,setListening]=useState(false);
  const[supported]=useState(()=>"webkitSpeechRecognition" in window||"SpeechRecognition" in window);
  const recRef=useRef(null);
  const start=useCallback(onResult=>{
    if(!supported||listening)return;
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const rec=new SR();
    rec.lang="en-US";rec.continuous=false;rec.interimResults=false;
    rec.onstart=()=>setListening(true);
    rec.onend=()=>setListening(false);
    rec.onerror=()=>setListening(false);
    rec.onresult=e=>onResult(e.results[0][0].transcript);
    recRef.current=rec;
    try{rec.start();}catch{setListening(false);}
  },[supported,listening]);
  const stop=useCallback(()=>{try{recRef.current?.stop();}catch{}setListening(false);},[]);
  const toggle=useCallback(onResult=>{if(listening)stop();else start(onResult);},[listening,start,stop]);
  return{listening,supported,toggle};
}

function MicBtn({onResult,currentValue,append}){
  const{listening,supported,toggle}=useVoice();
  if(!supported)return null;
  return(
    <button onClick={()=>toggle(t=>onResult(append&&currentValue?currentValue+" "+t:t))}
      style={{width:40,height:40,borderRadius:10,flexShrink:0,cursor:"pointer",background:listening?"#ff3b30":"rgba(255,107,0,0.1)",border:`2px solid ${listening?"#ff3b30":"rgba(255,107,0,0.3)"}`,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:listening?"0 0 14px rgba(255,59,48,0.5)":"none",transition:"all 0.2s"}}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect x="9" y="2" width="6" height="12" rx="3" fill={listening?"#fff":"#ff6b00"}/>
        <path d="M5 10a7 7 0 0014 0" stroke={listening?"#fff":"#ff6b00"} strokeWidth="2" strokeLinecap="round"/>
        <line x1="12" y1="19" x2="12" y2="22" stroke={listening?"#fff":"#ff6b00"} strokeWidth="2" strokeLinecap="round"/>
      </svg>
    </button>
  );
}

const SEV_I18N={"Critical":"severity.critical","Major":"severity.major","Minor":"severity.minor","Observation":"severity.observation"};
const WORKCAT_I18N={"Building Defects (Landed)":"work_categories.landed","Building Defects (Highrise)":"work_categories.highrise","Construction Site":"work_categories.construction","Interior Works":"work_categories.interior","Facilities Management":"work_categories.facilities","Infrastructure Works":"work_categories.infrastructure","Others":"work_categories.others"};
const sevDisplayFn=v=>SEV_I18N[v]?t(SEV_I18N[v]):v;
const workcatDisplayFn=v=>WORKCAT_I18N[v]?t(WORKCAT_I18N[v]):v;
const SevChip=({s})=><span style={{display:"inline-flex",alignItems:"center",padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",color:SEV_COLOR[s],background:SEV_BG[s]}}>{(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase()}</span>;
const STATUS_I18N={"Open":"status.open","In Progress":"status.in_progress","Done":"status.done","Verified":"status.verified","Closed":"status.closed"};
const StatusChip=({s})=><span style={{display:"inline-flex",alignItems:"center",padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",color:STATUS_COLOR[s],background:STATUS_COLOR[s]+"22"}}>{(STATUS_I18N[s]?t(STATUS_I18N[s]):s).toUpperCase()}</span>;
const RoleChip=({r})=><span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:ROLE_COLOR[r]||"#888",background:(ROLE_COLOR[r]||"#888")+"18"}}>{(r||"").toUpperCase()}</span>;
const lbl=(c="rgba(0,0,0,0.4)")=>({fontSize:11,fontWeight:700,color:c,letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif",display:"block",marginBottom:6});
const inp={flex:1,background:"#fff",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:"11px 14px",color:"#1a1a1a",fontSize:14,fontFamily:"'Barlow',sans-serif",outline:"none"};
const darkInp={background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"13px 16px",color:"#fff",fontSize:15,width:"100%",fontFamily:"'Barlow',sans-serif",outline:"none"};

function Spin({size=14}){
  return <div style={{width:size,height:size,border:"2px solid currentColor",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block"}}/>;
}

function VoiceField({label,value,onChange,placeholder,multiline}){
  return(
    <div style={{marginBottom:16}}>
      <label style={lbl()}>{label}</label>
      <div style={{display:"flex",gap:8,alignItems:multiline?"flex-start":"center"}}>
        {multiline
          ?<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={3} style={{...inp,resize:"none",flex:1}}/>
          :<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={inp}/>
        }
        <MicBtn onResult={t=>onChange(t)} append={multiline} currentValue={value}/>
      </div>
    </div>
  );
}

// ComboField: voice/manual text input first, with LIST button to open dropdown.
// Default shows text input + mic. Tap LIST to browse predefined options.
function ComboField({label,value,onChange,options,placeholder,grouped,displayFn}){
  const _d=displayFn||(v=>v);
  const[open,setOpen]=useState(false);
  const[search,setSearch]=useState("");

  // Default state — text input + voice mic + LIST button
  if(!open)return(
    <div style={{marginBottom:16}}>
      <label style={lbl()}>{label}</label>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input value={_d(value)} onChange={e=>onChange(e.target.value)} placeholder={placeholder||"Type or tap LIST..."} style={{...inp,flex:1}} readOnly={!!displayFn}/>
        <MicBtn onResult={t=>onChange(t)} currentValue={value}/>
        <button onClick={()=>{setSearch("");setOpen(true);}} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"8px 10px",fontSize:11,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,flexShrink:0}}>{t("actions.list")}</button>
      </div>
    </div>
  );

  // Expanded dropdown — grouped options (e.g. COMPONENT_GROUPS)
  if(grouped){
    const filteredGroups=search
      ?Object.fromEntries(Object.entries(grouped).map(([g,items])=>[g,items.filter(it=>{const q=search.toLowerCase();return it.toLowerCase().includes(q)||_d(it).toLowerCase().includes(q);})]).filter(([,items])=>items.length>0))
      :grouped;
    return(
      <div style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <label style={{...lbl(),marginBottom:0}}>{label}</label>
          <button onClick={()=>setOpen(false)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"4px 10px",fontSize:10,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"rgba(0,0,0,0.5)"}}>{t("actions.close_list")}</button>
        </div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("fields.search_list")} style={{...inp,flex:1,fontSize:13}}/>
          <MicBtn onResult={t=>setSearch(t)} currentValue={search}/>
        </div>
        <div style={{maxHeight:200,overflowY:"auto",borderRadius:10,border:"1px solid rgba(0,0,0,0.08)"}}>
          {Object.entries(filteredGroups).map(([group,items])=>(
            <div key={group}>
              <div style={{padding:"6px 12px",background:"#f5f5f5",fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.45)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em",position:"sticky",top:0,zIndex:2,borderBottom:"1px solid rgba(0,0,0,0.06)"}}>{_d(group).toUpperCase()}</div>
              {items.map(it=>(
                <div key={it} onClick={()=>{onChange(it);setOpen(false);setSearch("");}} style={{padding:"10px 12px",cursor:"pointer",background:value===it?"rgba(255,107,0,0.08)":"#fff",borderBottom:"1px solid rgba(0,0,0,0.04)",fontSize:14,color:value===it?"#ff6b00":"#1a1a1a",fontWeight:value===it?700:400}}>
                  {_d(it)}
                </div>
              ))}
            </div>
          ))}
          {Object.keys(filteredGroups).length===0&&<div style={{padding:16,textAlign:"center",color:"rgba(0,0,0,0.3)",fontSize:13}}>{t("messages.no_match")}</div>}
        </div>
      </div>
    );
  }

  // Expanded dropdown — flat options list
  const filtered=search
    ?(options||[]).filter(it=>{const q=search.toLowerCase();return it.toLowerCase().includes(q)||_d(it).toLowerCase().includes(q);})
    :options||[];
  return(
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <label style={{...lbl(),marginBottom:0}}>{label}</label>
        <button onClick={()=>setOpen(false)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"4px 10px",fontSize:10,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"rgba(0,0,0,0.5)"}}>{t("actions.close_list")}</button>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("fields.search_list")} style={{...inp,flex:1,fontSize:13}}/>
        <MicBtn onResult={t=>setSearch(t)} currentValue={search}/>
      </div>
      <div style={{maxHeight:200,overflowY:"auto",borderRadius:10,border:"1px solid rgba(0,0,0,0.08)"}}>
        {filtered.map(opt=>(
          <div key={opt} onClick={()=>{onChange(opt);setOpen(false);setSearch("");}} style={{padding:"10px 12px",cursor:"pointer",background:value===opt?"rgba(255,107,0,0.08)":"#fff",borderBottom:"1px solid rgba(0,0,0,0.04)",fontSize:14,color:value===opt?"#ff6b00":"#1a1a1a",fontWeight:value===opt?700:400}}>
            {_d(opt)}
          </div>
        ))}
        {filtered.length===0&&<div style={{padding:16,textAlign:"center",color:"rgba(0,0,0,0.3)",fontSize:13}}>{t("messages.no_match")}</div>}
      </div>
    </div>
  );
}

function SettingsBack({onClose,title}){
  return(
    <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12}}>
      <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff"}}>{title}</div>
    </div>
  );
}

// ── Server URL Configurator ───────────────────────────────────────
// Lets users point the app at their own PocketBase instance without
// touching the browser console. Saved URL persists via localStorage
// (same key as index.html reads on startup).
function ServerUrlConfig(){
  const[open,setOpen]=useState(false);
  const[showGuide,setShowGuide]=useState(false);
  const[url,setUrl]=useState(()=>localStorage.getItem('pb_url')||'https://api.siteshrimp.org');
  const[saved,setSaved]=useState(false);
  const apply=()=>{
    const cleaned=url.trim().replace(/\/+$/,'');
    if(!cleaned)return;
    localStorage.setItem('pb_url',cleaned);
    setSaved(true);
    setTimeout(()=>window.location.reload(),800);
  };
  const reset=()=>{
    setUrl('https://api.siteshrimp.org');
  };
  const linkStyle={color:'#ff6b00',textDecoration:'underline',fontWeight:600};
  return(
    <div style={{marginTop:16}}>
      <button onClick={()=>setOpen(o=>!o)} style={{background:'none',border:'none',color:'rgba(255,255,255,0.25)',fontSize:12,cursor:'pointer',width:'100%',textAlign:'center',fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:'0.06em',padding:'4px 0'}}>
        ⚙ {open?t("actions.hide"):t("server.title")}
      </button>
      {open&&(
        <div style={{marginTop:8,padding:'12px 14px',background:'rgba(255,255,255,0.05)',borderRadius:10,border:'1px solid rgba(255,255,255,0.1)'}}>
          <label style={lbl('rgba(255,255,255,0.4)')}>{t("server.pocketbase_url")}</label>
          <div style={{display:'flex',gap:8}}>
            <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://your-server.example.com" style={{...darkInp,flex:1,fontSize:13,padding:'9px 12px'}}/>
            <button onClick={apply} style={{background:'#ff6b00',border:'none',borderRadius:8,padding:'0 14px',color:'#fff',fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:'pointer',flexShrink:0}}>
              {saved?'✓':t("actions.set")}
            </button>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6}}>
            <button onClick={reset} style={{background:'none',border:'none',color:'rgba(255,255,255,0.3)',fontSize:11,cursor:'pointer',padding:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>↺ reset to default</button>
            <span style={{fontSize:11,color:'rgba(255,255,255,0.2)'}}>Reloads on save</span>
          </div>
          <button onClick={()=>setShowGuide(g=>!g)} style={{background:'none',border:'none',color:'#ff6b00',fontSize:11,cursor:'pointer',width:'100%',textAlign:'left',padding:'8px 0 0',fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>
            {showGuide?'▼':'▶'} How do I run my own PocketBase?
          </button>
          {showGuide&&(
            <div style={{marginTop:6,padding:'10px 12px',background:'rgba(255,107,0,0.06)',borderRadius:8,border:'1px solid rgba(255,107,0,0.15)',fontSize:11,color:'rgba(255,255,255,0.55)',lineHeight:1.7}}>
              <div style={{color:'#ff9500',fontWeight:700,marginBottom:6}}>QUICK START</div>
              <div style={{marginBottom:4}}>1. Download from <a href="https://pocketbase.io/docs" target="_blank" rel="noopener" style={linkStyle}>pocketbase.io/docs</a></div>
              <div style={{marginBottom:4}}>2. Unzip and run <code style={{background:'rgba(0,0,0,0.4)',padding:'1px 5px',borderRadius:4}}>./pocketbase serve</code></div>
              <div style={{marginBottom:4}}>3. Open <code style={{background:'rgba(0,0,0,0.4)',padding:'1px 5px',borderRadius:4}}>http://127.0.0.1:8090/_/</code> and create an admin</div>
              <div style={{marginBottom:4}}>4. Paste that URL above and click Set</div>
              <div style={{marginTop:8,paddingTop:8,borderTop:'1px dashed rgba(255,255,255,0.1)',fontSize:10,color:'rgba(255,255,255,0.4)'}}>For public access over HTTPS, put PocketBase behind a reverse proxy (Caddy, Nginx, or <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank" rel="noopener" style={linkStyle}>Cloudflare Tunnel</a>). Full hosting guide available in Help → Hosting after you sign in.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Language Selector (compact — for auth/intro pages) ───────────
function LangButton(){
  const[open,setOpen]=useState(false);
  const[,tick]=useState(0);
  useEffect(()=>onLangChange(()=>tick(t=>t+1)),[]);
  const current=LANGUAGES.find(l=>l.code===_currentCode)||LANGUAGES[0];
  return(
    <div style={{position:"relative",display:"inline-block"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:20,padding:"5px 12px 5px 8px",color:"rgba(255,255,255,0.7)",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:16}}>{current.flag}</span> {current.name} <span style={{fontSize:9,color:"rgba(255,255,255,0.35)"}}>▼</span>
      </button>
      {open&&(
        <div style={{position:"absolute",bottom:"110%",left:0,background:"linear-gradient(180deg,#2e2e32 0%,#1f1f22 100%)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:12,overflow:"hidden",zIndex:999,minWidth:200,maxHeight:320,overflowY:"auto",boxShadow:"0 16px 48px rgba(0,0,0,0.55)"}}>
          {LANGUAGES.map(l=>(
            <button key={l.code} onClick={()=>{loadLanguage(l.code);setOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 14px",background:_currentCode===l.code?"rgba(255,107,0,0.12)":"transparent",border:"none",cursor:"pointer",textAlign:"left",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
              <span style={{fontSize:18}}>{l.flag}</span>
              <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,fontSize:13,color:_currentCode===l.code?"#ff6b00":"#fff"}}>{l.name}</span>
              {_currentCode===l.code&&<span style={{marginLeft:"auto",color:"#ff6b00",fontSize:13,fontWeight:800}}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Screen: Auth (with intro + install prompt) ───────────────────
function AuthScreen({onAuth,onFullSetup}){
  const[page,setPage]=useState("intro");
  const[mode,setMode]=useState("login");
  const[email,setEmail]=useState("");const[pw,setPw]=useState("");const[name,setName]=useState("");
  const[cName,setCName]=useState("");
  const[code,setCode]=useState("");const[showInvite,setShowInvite]=useState(false);
  const[err,setErr]=useState("");const[loading,setLoading]=useState(false);const[step,setStep]=useState("");const[showPw,setShowPw]=useState(false);
  const[installable,setInstallable]=useState(!!_deferredInstallPrompt);
  const[showIOSGuide,setShowIOSGuide]=useState(false);
  const[viewportH,setViewportH]=useState(window.innerHeight||800);
  const isIOS=useMemo(()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&"ontouchend"in document),[]);
  const isStandalone=useMemo(()=>window.matchMedia("(display-mode:standalone)").matches||navigator.standalone===true,[]);
  const showIOSBanner=isIOS&&!isStandalone;
  const inv=new URLSearchParams(window.location.search).get("invite")||"";

  useEffect(()=>{if(inv){setPage("auth");setMode("register");setShowInvite(true);setCode(inv);}},[]);

  useEffect(()=>{
    const check=()=>setInstallable(!!_deferredInstallPrompt);
    window.addEventListener("beforeinstallprompt",check);
    return()=>window.removeEventListener("beforeinstallprompt",check);
  },[]);

  useEffect(()=>{
    const onResize=()=>setViewportH(window.innerHeight||800);
    window.addEventListener("resize",onResize);
    window.addEventListener("orientationchange",onResize);
    return()=>{
      window.removeEventListener("resize",onResize);
      window.removeEventListener("orientationchange",onResize);
    };
  },[]);

  // Mobile viewport presets tuned for common phone heights (~640-915 CSS px)
  const introPreset=viewportH<=700
    ? {padding:"14px 16px",maxWidth:360,icon:48,title:33,sub:13.5,body:13,lineH:1.36,titleGap:5,textGap:8,rowPad:"2px 0",rowGap:8,featTitle:14,featDesc:13,btnPad:"11px",btnFont:15,btnGap:7,footer:12}
    : viewportH<=820
      ? {padding:"18px 20px",maxWidth:380,icon:54,title:36,sub:14.5,body:14,lineH:1.42,titleGap:6,textGap:11,rowPad:"3px 0",rowGap:9,featTitle:15,featDesc:14,btnPad:"12px",btnFont:16,btnGap:7,footer:13}
      : {padding:"22px 24px",maxWidth:390,icon:58,title:38,sub:15,body:14.5,lineH:1.45,titleGap:7,textGap:12,rowPad:"4px 0",rowGap:10,featTitle:15.5,featDesc:14.5,btnPad:"13px",btnFont:16.5,btnGap:8,footer:13.5};

  const installApp=async()=>{
    if(!_deferredInstallPrompt)return;
    _deferredInstallPrompt.prompt();
    const result=await _deferredInstallPrompt.userChoice;
    if(result.outcome==="accepted")setInstallable(false);
    _deferredInstallPrompt=null;
  };

  const submit=async()=>{
    // ── Login ──
    if(mode==="login"){
      if(!email.trim()||!pw.trim())return;
      setLoading(true);setErr("");setStep("Logging in...");
      try{
        const c=await DB.auth.login(email.trim(),pw);
        // Try to find company during login so user goes straight to dashboard
        setStep("Loading workspace...");
        try{
          const result=await DB.findUserCompany(c.user.id);
          if(result){
            const cd={companyId:result.companyId,companyName:result.companyName};
            const projs=await DB.projects.list(`companyId="${result.companyId}" && archived!=true`);
            const proj=projs.length?{id:projs[0].id,name:projs[0].name}:null;
            onFullSetup(c.user,cd,proj);
          }else{
            onAuth(c.user,null,inv);
          }
        }catch{
          onAuth(c.user,null,inv); // Fallback: let auth callback handle it
        }
      }catch(e){
        setErr(e.message||"Something went wrong.");
      }
      setLoading(false);setStep("");
      return;
    }

    // ── Register (minimal: name, email, pw, company or invite) ──
    if(!name.trim()||!email.trim()||!pw.trim()){setErr("Name, email and password are required.");return;}
    if(showInvite&&!code.trim()){setErr("Please enter your invite code.");return;}
    if(!showInvite&&!cName.trim()){setErr("Please enter your company name.");return;}

    setLoading(true);setErr("");
    try{
      setStep("Creating account...");
      const c=await DB.auth.register(email.trim(),pw,name.trim());
      const user=c.user;

      if(showInvite){
        setStep("Joining team...");
        const parts=code.trim().split(":");
        if(parts.length!==2)throw new Error("Invalid invite code — should be companyId:code");
        const[companyId,invCode]=parts;
        const invite=await DB.invites.getFirst(`companyId="${companyId}" && code="${invCode}"`);
        if(!invite)throw new Error("Invite not found or expired.");
        if(invite.usedBy)throw new Error("This invite has already been used.");
        if(invite.expiresAt&&new Date(invite.expiresAt)<new Date())throw new Error("Invite expired.");
        await DB.members.create({
          companyId,userId:user.id,name:name.trim(),email:user.email,
          role:invite.role,jobTitle:invite.jobTitle||JOB_TITLES[0],joinedAt:DB.serverTimestamp()
        });
        await DB.invites.update(invite.id,{usedBy:user.id,usedAt:DB.serverTimestamp()});
        const compDoc=await DB.companies.get(companyId);
        const projs=await DB.projects.list(`companyId="${companyId}"`);
        const proj=projs.length?{id:projs[0].id,name:projs[0].name}:null;
        onFullSetup(user,{companyId,companyName:compDoc.name},proj);
      }else{
        setStep("Setting up workspace...");
        const result=await DB.createCompany(cName.trim(),user.id,user.email,name.trim(),JOB_TITLES[0]);
        onFullSetup(user,{companyId:result.company.id,companyName:cName.trim()},{id:result.project.id,name:"Default Project"});
      }
    }catch(e){
      const msg=e.message||"";
      if(msg.includes("must be unique"))setErr("Email already registered. Switch to LOGIN.");
      else setErr(msg||"Something went wrong.");
    }
    setLoading(false);setStep("");
  };

  const resetPw=async()=>{
    if(!email.trim()){setErr("Enter your email first.");return;}
    try{
      await DB.auth.resetPassword(email.trim());
      setErr("Reset email sent. Check your inbox (and spam folder).\nIf no email arrives, contact your admin to reset your password.");
    }catch{setErr("Could not send reset email. Email service may not be configured.\nContact your admin to reset your password.");}
  };

  // ── Intro / Welcome page ──
  if(page==="intro")return(
    <div style={{minHeight:"100dvh",background:"#1a1a1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",padding:introPreset.padding,textAlign:"center"}}>
      <div style={{width:"100%",maxWidth:introPreset.maxWidth,minHeight:"calc(100dvh - 36px)",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
        <div>
          <img src="icons/icon-192.png" alt="SiteShrimp" style={{width:introPreset.icon,height:introPreset.icon,borderRadius:8,marginBottom:9,boxShadow:"0 4px 20px rgba(255,107,0,0.3)"}}/>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:introPreset.title,fontWeight:800,color:"#fff",lineHeight:1,marginBottom:introPreset.titleGap}}>SITESHRIMP</div>
          <div style={{color:"rgba(255,255,255,0.56)",fontSize:introPreset.sub,marginBottom:4,lineHeight:introPreset.lineH}}>
            {t("onboarding.tagline")}
          </div>
          <div style={{color:"rgba(255,255,255,0.42)",fontSize:introPreset.body,marginBottom:introPreset.textGap,lineHeight:introPreset.lineH}}>
            {t("onboarding.subtitle")}
          </div>

          <div style={{textAlign:"left",marginBottom:introPreset.textGap}}>
          {[
            ["📷",t("onboarding.log_faster_ai"),t("onboarding.log_faster_ai_desc")],
            ["📐",t("onboarding.see_issues"),t("onboarding.see_issues_desc")],
            ["🎤",t("onboarding.hands_free"),t("onboarding.hands_free_desc")],
            ["📋",t("onboarding.audit_trail"),t("onboarding.audit_trail_desc")],
            ["👥",t("onboarding.coordinate_title"),t("onboarding.coordinate_desc")],
            ["📊",t("onboarding.report_title"),t("onboarding.report_desc")],
          ].map(([icon,title,desc],i)=>(
            <div key={i} className="anim" style={{animationDelay:`${i*0.05}s`,display:"flex",gap:introPreset.rowGap,alignItems:"flex-start",padding:introPreset.rowPad}}>
              <span style={{fontSize:introPreset.featTitle,flexShrink:0,marginTop:1}}>{icon}</span>
              <div>
                <span style={{color:"#fff",fontSize:introPreset.featTitle,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif"}}>{title}</span>
                <span style={{color:"rgba(255,255,255,0.42)",fontSize:introPreset.featDesc}}> — {desc}</span>
              </div>
            </div>
          ))}
          </div>
        </div>
        <div style={{textAlign:"center"}}>
          <button onClick={()=>setPage("auth")} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:11,padding:introPreset.btnPad,color:"#fff",fontSize:introPreset.btnFont,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:8,letterSpacing:"0.04em"}}>{t("actions.get_started")}</button>

          <button onClick={installable?installApp:()=>setShowIOSGuide(true)} style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:11,padding:introPreset.btnPad,color:"rgba(255,255,255,0.82)",fontSize:introPreset.btnFont,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:9,display:"flex",alignItems:"center",justifyContent:"center",gap:introPreset.btnGap}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="rgba(255,255,255,0.82)" strokeWidth="2" strokeLinecap="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="rgba(255,255,255,0.82)" strokeWidth="2" strokeLinecap="round"/></svg>
            {t("onboarding.install_app").toUpperCase()}
          </button>

          {showIOSBanner&&!showIOSGuide&&(
            <div onClick={()=>setShowIOSGuide(true)} style={{background:"rgba(0,122,255,0.12)",border:"1px solid rgba(0,122,255,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:9,cursor:"pointer",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
              <span style={{fontSize:22,flexShrink:0}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M17 2H7a3 3 0 00-3 3v14a3 3 0 003 3h10a3 3 0 003-3V5a3 3 0 00-3-3z" stroke="rgba(0,122,255,0.9)" strokeWidth="1.5"/><circle cx="12" cy="18" r="1" fill="rgba(0,122,255,0.9)"/></svg>
              </span>
              <div>
                <div style={{color:"rgba(255,255,255,0.9)",fontSize:introPreset.featTitle,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif"}}>{t("onboarding.ios_banner_title")}</div>
                <div style={{color:"rgba(255,255,255,0.5)",fontSize:introPreset.featDesc}}>{t("onboarding.ios_banner_subtitle")}</div>
              </div>
            </div>
          )}

          <div style={{display:"flex",justifyContent:"center",marginTop:8}}>
            <LangButton/>
          </div>
          <div style={{color:"rgba(255,255,255,0.62)",fontSize:introPreset.footer,fontFamily:"'Barlow Condensed',sans-serif",textAlign:"center",marginTop:48}}>
            {t("onboarding.free_for_all")}
          </div>
        </div>
      </div>

      {showIOSGuide&&(
        <div onClick={()=>setShowIOSGuide(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:9999,display:"flex",alignItems:"flex-end",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#2a2a2a",borderRadius:16,padding:"22px 20px",maxWidth:360,width:"100%",marginBottom:16,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{color:"#fff",fontSize:18,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif"}}>{t("onboarding.ios_guide_title")}</div>
              <button onClick={()=>setShowIOSGuide(false)} style={{background:"none",border:"none",color:"rgba(255,255,255,0.5)",fontSize:22,cursor:"pointer",padding:"0 4px"}}>&times;</button>
            </div>
            {[
              {step:"1",icon:(<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"/></svg>),text:t("onboarding.ios_step_1")},
              {step:"2",icon:(<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="4" stroke="#007AFF" strokeWidth="2"/><path d="M12 8v8m-4-4h8" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"/></svg>),text:t("onboarding.ios_step_2")},
              {step:"3",icon:(<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#34C759" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>),text:t("onboarding.ios_step_3")},
            ].map(({step,icon,text})=>(
              <div key={step} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:14}}>
                <div style={{width:36,height:36,background:"rgba(255,255,255,0.08)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {icon}
                </div>
                <div style={{color:"rgba(255,255,255,0.85)",fontSize:14.5,lineHeight:1.45,paddingTop:6}}><b style={{color:"#fff"}}>{step}.</b> {text}</div>
              </div>
            ))}
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:12.5,textAlign:"center",marginTop:4,lineHeight:1.4}}>{t("onboarding.ios_note")}</div>
          </div>
        </div>
      )}
    </div>
  );

  // ── Login / Register page (consolidated) ──
  return(
    <div style={{minHeight:"100dvh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:"18px 16px",overflowY:"auto"}}>
      <div style={{width:"100%",maxWidth:420}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={()=>setPage("intro")} style={{background:"rgba(255,255,255,0.07)",border:"none",borderRadius:20,padding:"6px 12px",color:"rgba(255,255,255,0.5)",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,flexShrink:0}}>←</button>
          <img src="icons/icon-192.png" alt="SiteShrimp" style={{width:44,height:44,borderRadius:8,boxShadow:"0 4px 14px rgba(255,107,0,0.3)",flexShrink:0}}/>
          <div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#fff",lineHeight:1}}>SITESHRIMP</div>
            <div style={{color:"rgba(255,255,255,0.45)",fontSize:12}}>{t("help.tracker_tagline")}</div>
          </div>
        </div>

        {/* Mode tabs */}
        <div style={{display:"flex",gap:8,marginBottom:20}}>
          {["login","register"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");setStep("");}} style={{flex:1,background:mode===m?"#ff6b00":"rgba(255,255,255,0.07)",border:"none",borderRadius:10,padding:"12px",color:mode===m?"#fff":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,cursor:"pointer"}}>{m==="login"?"LOGIN":"SIGN UP"}</button>
          ))}
        </div>

        {mode==="register"&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>NAME</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={darkInp}/></div>}
        <div style={{marginBottom:12}}><label style={lbl("#fff")}>EMAIL</label><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" type="email" style={darkInp}/></div>
        <div style={{marginBottom:mode==="register"?12:16}}><label style={lbl("#fff")}>PASSWORD</label><div style={{position:"relative"}}><input value={pw} onChange={e=>setPw(e.target.value)} placeholder={mode==="register"?"Min 8 characters":"Password"} type={showPw?"text":"password"} style={{...darkInp,paddingRight:44}}/><button type="button" onClick={()=>setShowPw(!showPw)} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",padding:6,color:"rgba(255,255,255,0.4)",fontSize:16}}>{showPw?<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/></svg>}</button></div></div>
        {mode==="register"&&!showInvite&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>COMPANY NAME</label><input value={cName} onChange={e=>setCName(e.target.value)} placeholder="Your company or organisation" style={darkInp}/></div>}
        {mode==="register"&&showInvite&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>INVITE CODE</label><input value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste invite code from your admin" style={darkInp}/></div>}
        {mode==="register"&&!inv&&<button onClick={()=>{setShowInvite(!showInvite);setErr("");}} style={{background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:11,cursor:"pointer",padding:"0 0 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{showInvite?"← Creating a new company":"Have an invite code?"}</button>}

        {err&&<div style={{background:err.startsWith("Reset")?"rgba(0,229,100,0.1)":"rgba(255,59,48,0.12)",border:`1px solid ${err.startsWith("Reset")?"rgba(0,229,100,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"10px 14px",marginBottom:14,color:err.startsWith("Reset")?"#00e564":"#ff6b6b",fontSize:13,whiteSpace:"pre-line"}}>{err}</div>}

        <button onClick={submit} disabled={loading} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10,opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          {loading?<Spin size={16}/>:null}{loading?(step||"..."):(mode==="login"?"LOGIN":"GET STARTED")}
        </button>

        {mode==="login"&&<button onClick={resetPw} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:13,cursor:"pointer",padding:"8px"}}>Forgot password?</button>}

        <ServerUrlConfig/>

        <div style={{display:"flex",justifyContent:"center",marginTop:12}}>
          <LangButton/>
        </div>

      </div>
    </div>
  );
}

// ── Fallback: Company Setup for existing users without a company ──
function CompanySetup({user,inviteCode,onDone,onSignOut}){
  const[mode,setMode]=useState(inviteCode?"join":"create");
  const[cName,setCName]=useState("");const[code,setCode]=useState(inviteCode||"");
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const[checking,setChecking]=useState(true);

  // Auto-check if user already has a company before showing form
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      for(let i=0;i<3;i++){
        try{
          const result=await DB.findUserCompany(user.id);
          if(cancelled)return;
          if(result){
            const cd={companyId:result.companyId,companyName:result.companyName};
            local.set(COMPANY_KEY,cd);
            const projs=await DB.projects.list(`companyId="${result.companyId}" && archived!=true`);
            const proj=projs.length?{id:projs[0].id,name:projs[0].name}:null;
            if(proj)local.set(PROJECT_KEY,proj);
            onDone(cd,proj);
            return;
          }
          break; // No company found, show form
        }catch(e){
          console.warn(`Company check attempt ${i+1}:`,e);
          setErr(`Retry ${i+1}/3: ${e.message}`);
          if(i<2)await new Promise(r=>setTimeout(r,2000));
        }
      }
      if(!cancelled)setChecking(false);
    })();
    return()=>{cancelled=true;};
  },[]);

  const create=async()=>{
    if(!cName.trim())return;
    setLoading(true);setErr("");
    try{
      const result=await DB.createCompany(cName.trim(),user.id,user.email,user.name||user.email,JOB_TITLES[0]);
      onDone({companyId:result.company.id,companyName:cName.trim()},{id:result.project.id,name:"Default Project"});
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  const join=async()=>{
    if(!code.trim())return;
    setLoading(true);setErr("");
    try{
      const parts=code.trim().split(":");
      if(parts.length!==2)throw new Error("Invalid invite code — should be companyId:code");
      const[companyId,invCode]=parts;
      const invite=await DB.invites.getFirst(`companyId="${companyId}" && code="${invCode}"`);
      if(!invite)throw new Error("Invite not found or expired.");
      if(invite.usedBy)throw new Error("This invite has already been used.");
      if(invite.expiresAt&&new Date(invite.expiresAt)<new Date())throw new Error("Invite expired.");
      await DB.members.create({
        companyId,userId:user.id,name:user.name||user.email,email:user.email,
        role:invite.role,jobTitle:invite.jobTitle||JOB_TITLES[0],joinedAt:DB.serverTimestamp()
      });
      await DB.invites.update(invite.id,{usedBy:user.id,usedAt:DB.serverTimestamp()});
      const compDoc=await DB.companies.get(companyId);
      const projs=await DB.projects.list(`companyId="${companyId}"`);
      const proj=projs.length?{id:projs[0].id,name:projs[0].name}:null;
      onDone({companyId,companyName:compDoc.name},proj);
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  if(checking)return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff6b00",marginBottom:16}}>SITESHRIMP</div>
        <Spin size={24}/>
        <div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginTop:12}}>Finding your workspace...</div>
      </div>
    </div>
  );

  return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:28}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#fff",marginBottom:4}}>SETUP WORKSPACE</div>
        <div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginBottom:20}}>{user.email}</div>
        {mode==="create"&&<>
          <div style={{marginBottom:14}}><label style={lbl("#fff")}>COMPANY NAME</label><input value={cName} onChange={e=>setCName(e.target.value)} placeholder="Your company or organisation" style={darkInp}/></div>
          <button onClick={create} disabled={loading||!cName.trim()} style={{width:"100%",background:cName.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {loading?<Spin size={16}/>:null}{loading?"CREATING...":"CREATE COMPANY"}
          </button>
          <button onClick={()=>setMode("join")} style={{background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:11,cursor:"pointer",padding:"14px 0",width:"100%",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>Have an invite code?</button>
        </>}
        {mode==="join"&&<>
          <div style={{marginBottom:14}}><label style={lbl("#fff")}>INVITE CODE</label><input value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste invite code from your admin" style={darkInp}/></div>
          <button onClick={join} disabled={loading||!code.trim()} style={{width:"100%",background:code.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {loading?<Spin size={16}/>:null}{loading?"JOINING...":"JOIN COMPANY"}
          </button>
          <button onClick={()=>setMode("create")} style={{background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:11,cursor:"pointer",padding:"14px 0",width:"100%",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>Creating a new company?</button>
        </>}
        {err&&<div style={{background:"rgba(255,59,48,0.12)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:"10px 14px",marginTop:14,color:"#ff6b6b",fontSize:13}}>{err}</div>}
        <button onClick={onSignOut} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.2)",fontSize:12,cursor:"pointer",padding:"16px 8px",marginTop:8}}>Sign out</button>
      </div>
    </div>
  );
}

// ── User Management (Admin only) ──────────────────────────────────
function UserManagement({onClose,company,member,members}){
  const[invRole,setInvRole]=useState("Inspector");
  const[invJob,setInvJob]=useState(JOB_TITLES[0]);const[invCustomJob,setInvCustomJob]=useState("");
  const[link,setLink]=useState("");
  const[gen,setGen]=useState(false);
  const[copied,setCopied]=useState(false);
  const[editing,setEditing]=useState(null);

  const genInvite=async()=>{
    setGen(true);setLink("");
    try{
      const code=Math.random().toString(36).substring(2,10).toUpperCase();
      const finalInvJob=invJob==="Other"?invCustomJob.trim()||"Other":invJob;
      await DB.invites.create({
        companyId:company.companyId,code,role:invRole,jobTitle:finalInvJob,
        createdBy:DB.auth.currentUser.id,
        expiresAt:new Date(Date.now()+7*24*60*60*1000).toISOString()
      });
      const url=`${window.location.origin}${window.location.pathname}?invite=${company.companyId}:${code}`;
      setLink(url);
    }catch(e){alert(e.message);}
    setGen(false);
  };

  const copyLink=()=>{
    navigator.clipboard.writeText(link).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2500);});
  };

  const changeRole=async(uid,role)=>{
    const mem=members.find(m=>m.userId===uid);
    if(mem)await DB.members.update(mem.id,{role});
    setEditing(null);
  };

  const removeMember=async uid=>{
    if(!confirm("Remove this member from the company?"))return;
    const mem=members.find(m=>m.userId===uid);
    if(mem)await DB.members.delete(mem.id);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("team.title")}/>
      <div style={{padding:20}}>
        <div style={{background:"#fff",borderRadius:14,padding:14,marginBottom:16}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15}}>{company.companyName}</div>
          <div style={{fontSize:12,color:"rgba(0,0,0,0.4)",marginTop:2}}>{members.length} member{members.length!==1?"s":""} · ID: {company.companyId.substring(0,8)}...</div>
        </div>

        <div style={lbl()}>CURRENT MEMBERS</div>
        {members.map(m=>(
          <div key={m.uid} style={{background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:600,fontSize:14,color:"#1a1a1a"}}>{m.name}{m.uid===DB.auth.currentUser?.id?" (you)":""}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginTop:2}}>{m.email} · {m.jobTitle||"—"}</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <RoleChip r={m.role}/>
                {member.role==="Admin"&&m.uid!==DB.auth.currentUser?.id&&(
                  <button onClick={()=>setEditing(editing===m.uid?null:m.uid)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"5px 10px",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>Edit</button>
                )}
              </div>
            </div>
            {editing===m.uid&&(
              <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.06)"}}>
                <div style={lbl()}>CHANGE ROLE</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                  {ROLES.map(r=>(
                    <button key={r} onClick={()=>changeRole(m.uid,r)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${m.role===r?ROLE_COLOR[r]:"rgba(0,0,0,0.12)"}`,background:m.role===r?ROLE_COLOR[r]+"18":"#f9f9f9",color:m.role===r?ROLE_COLOR[r]:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{r.toUpperCase()}</button>
                  ))}
                </div>
                <button onClick={()=>removeMember(m.uid)} style={{background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:8,padding:"8px 14px",color:"#ff3b30",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>Remove Member</button>
              </div>
            )}
          </div>
        ))}

        <div style={{...lbl(),marginTop:20}}>INVITE NEW MEMBER</div>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
          <div style={{marginBottom:12}}>
            <div style={lbl()}>ASSIGN ROLE</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
              {ROLES.filter(r=>r!=="Admin").map(r=>(
                <button key={r} onClick={()=>setInvRole(r)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${invRole===r?ROLE_COLOR[r]:"rgba(0,0,0,0.12)"}`,background:invRole===r?ROLE_COLOR[r]+"18":"#f9f9f9",color:invRole===r?ROLE_COLOR[r]:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{r.toUpperCase()}</button>
              ))}
            </div>
            <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>
              {invRole==="Manager"?"Log, update defects · Manage projects · View reports":invRole==="Inspector"?"Log defects · Add comments · View all":"View defects only — no editing"}
            </div>
          </div>
          <div style={{marginBottom:invJob==="Other"?8:14}}>
            <div style={lbl()}>ROLE</div>
            <select value={invJob} onChange={e=>setInvJob(e.target.value)} style={{...inp,width:"100%",flex:"unset",appearance:"none"}}>
              {JOB_TITLES.map(t=><option key={t}>{t}</option>)}
            </select>
          </div>
          {invJob==="Other"&&<div style={{marginBottom:14}}><input value={invCustomJob} onChange={e=>setInvCustomJob(e.target.value)} placeholder="Enter custom job title" style={{...inp,width:"100%"}}/></div>}
          <button onClick={genInvite} disabled={gen} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {gen?<Spin size={14}/>:null}{gen?"GENERATING...":"GENERATE INVITE LINK"}
          </button>
          {link&&(
            <div style={{marginTop:12}}>
              <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:10,padding:"10px 12px",fontSize:11,color:"#1a7a35",wordBreak:"break-all",marginBottom:8}}>{link}</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={copyLink} style={{flex:1,background:copied?"rgba(48,209,88,0.1)":"rgba(0,0,0,0.06)",border:`1px solid ${copied?"rgba(48,209,88,0.3)":"rgba(0,0,0,0.1)"}`,borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",color:copied?"#1a7a35":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif"}}>{copied?"✓ COPIED!":"COPY LINK"}</button>
                <button onClick={()=>{if(navigator.share)navigator.share({title:"SiteShrimp Team Invite",url:link});else copyLink();}} style={{flex:1,background:"#ff6b00",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>SHARE</button>
              </div>
              <div style={{fontSize:11,color:"rgba(0,0,0,0.35)",textAlign:"center",marginTop:6}}>Expires in 7 days · Single use</div>
            </div>
          )}
        </div>

        <div style={{background:"rgba(0,0,0,0.04)",borderRadius:12,padding:14}}>
          <div style={{...lbl(),marginBottom:8}}>ROLE PERMISSIONS</div>
          {[["Admin","Full access · Manage users · Delete defects · Company settings"],["Manager","Log & update defects · Manage projects · Email reports"],["Inspector","Log defects · Add comments · View all defects"],["Viewer","Read-only access — view defects only"]].map(([r,d])=>(
            <div key={r} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
              <RoleChip r={r}/>
              <span style={{fontSize:12,color:"rgba(0,0,0,0.5)",paddingTop:1}}>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Project Management ────────────────────────────────────────────
function ProjectManagement({onClose,company,member,projects,currentProject,onSelect}){
  const[newName,setNewName]=useState("");const[adding,setAdding]=useState(false);
  const[editingId,setEditingId]=useState(null);const[editName,setEditName]=useState("");
  const[archived,setArchived]=useState([]);const[showArchived,setShowArchived]=useState(false);
  const canManage=["Admin","Manager"].includes(member?.role);

  useEffect(()=>{
    if(!showArchived||!company?.companyId)return;
    DB.projects.list(`companyId="${company.companyId}" && archived=true`).then(items=>{
      setArchived(items);
    });
  },[showArchived]);

  const restoreProject=async id=>{
    await DB.projects.update(id,{archived:false});
    setArchived(prev=>prev.filter(p=>p.id!==id));
  };

  const addProject=async()=>{
    if(!newName.trim())return;setAdding(true);
    try{
      const ref=await DB.projects.create({companyId:company.companyId,name:newName.trim(),createdAt:DB.serverTimestamp(),createdBy:DB.auth.currentUser?.id});
      onSelect({id:ref.id,name:newName.trim()});
      setNewName("");
    }catch(e){alert(e.message);}
    setAdding(false);
  };

  const renameProject=async(id)=>{
    if(!editName.trim())return;
    await DB.projects.update(id,{name:editName.trim()});
    if(currentProject?.id===id)onSelect({id,name:editName.trim()});
    setEditingId(null);setEditName("");
  };

  const archiveProject=async id=>{
    if(projects.length<=1){alert("Cannot archive the only project.");return;}
    if(!confirm("Archive this project? Defects will be preserved."))return;
    await DB.projects.update(id,{archived:true});
    if(currentProject?.id===id){const next=projects.find(p=>p.id!==id);if(next)onSelect(next);}
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("projects.title")}/>
      <div style={{padding:20}}>
        <div style={lbl()}>SELECT ACTIVE PROJECT</div>
        {projects.map(p=>(
          <div key={p.id} style={{background:currentProject?.id===p.id?"#ff6b00":"#fff",borderRadius:12,padding:"14px 16px",marginBottom:8}}>
            {editingId===p.id?(
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&renameProject(p.id)} style={{...inp,flex:1,marginBottom:0}} autoFocus/>
                <button onClick={()=>renameProject(p.id)} style={{background:"#30d158",border:"none",borderRadius:8,padding:"8px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Save</button>
                <button onClick={()=>setEditingId(null)} style={{background:"rgba(0,0,0,0.1)",border:"none",borderRadius:8,padding:"8px 12px",fontSize:12,cursor:"pointer"}}>✕</button>
              </div>
            ):(
              <div onClick={()=>{onSelect(p);onClose();}} style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:700,fontSize:14,color:currentProject?.id===p.id?"#fff":"#1a1a1a"}}>{p.name}</div>
                  {currentProject?.id===p.id&&<div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:2}}>Currently active</div>}
                </div>
                <div style={{display:"flex",gap:6}}>
                  {canManage&&<button onClick={e=>{e.stopPropagation();setEditingId(p.id);setEditName(p.name);}} style={{background:currentProject?.id===p.id?"rgba(255,255,255,0.2)":"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"5px 10px",color:currentProject?.id===p.id?"#fff":"#666",fontSize:12,cursor:"pointer"}}>Rename</button>}
                  {canManage&&currentProject?.id!==p.id&&<button onClick={e=>{e.stopPropagation();archiveProject(p.id);}} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"5px 10px",color:"#ff3b30",fontSize:12,cursor:"pointer"}}>Archive</button>}
                </div>
              </div>
            )}
          </div>
        ))}
        {canManage&&(
          <div style={{marginTop:14}}>
            <div style={lbl()}>ADD NEW PROJECT</div>
            <div style={{display:"flex",gap:8}}>
              <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Project name" style={{...inp,flex:1}}/>
              <button onClick={addProject} disabled={adding||!newName.trim()} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"11px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                {adding?<Spin size={12}/>:"ADD"}
              </button>
            </div>
          </div>
        )}
        {canManage&&(
          <div style={{marginTop:20}}>
            <button onClick={()=>setShowArchived(!showArchived)} style={{background:"none",border:"none",color:"rgba(0,0,0,0.4)",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,cursor:"pointer",letterSpacing:"0.08em"}}>{showArchived?"▼ HIDE":"▶ SHOW"} ARCHIVED PROJECTS</button>
            {showArchived&&(
              <div style={{marginTop:10}}>
                {archived.length===0?<div style={{fontSize:12,color:"rgba(0,0,0,0.3)",padding:8}}>No archived projects</div>:
                archived.map(p=>(
                  <div key={p.id} style={{background:"rgba(0,0,0,0.04)",borderRadius:10,padding:"10px 14px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontSize:13,color:"rgba(0,0,0,0.5)"}}>{p.name}</div>
                    <button onClick={()=>restoreProject(p.id)} style={{background:"rgba(48,209,88,0.12)",border:"none",borderRadius:8,padding:"5px 10px",color:"#30d158",fontSize:12,fontWeight:700,cursor:"pointer"}}>Restore</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Settings Sync (save to Firestore + localStorage) ─────────────
async function saveSettingToFirestore(companyId,key,value){
  if(!companyId)return;
  // Security hardening: keep integration secrets local on device.
  if(["telegram","gemini"].includes(key))return;
  try{
    const existing=await DB.settings.getFirst(`companyId="${companyId}" && key="${key}"`);
    if(existing)await DB.settings.update(existing.id,{value,updatedAt:DB.serverTimestamp()});
    else await DB.settings.create({companyId,key,value});
  }catch(e){console.warn("Settings save failed:",e);}
}
async function loadSettingsFromFirestore(companyId){
  if(!companyId)return;
  try{
    const items=await DB.settings.list(`companyId="${companyId}"`);
    items.forEach(doc=>{
      const key=doc.key;const val=doc.value;
      // Do not hydrate secret-bearing settings from shared backend storage.
      if(key==="telegram"||key==="gemini")return;
      // Hydrate email recipients from cloud (shared across team)
      if(key==="email"&&val&&val.recipients){local.set(EMAIL_KEY,val);return;}
      // Hydrate custom entry types from cloud (shared across team)
      if(key==="customEntryTypes"&&Array.isArray(val)){
        local.set(CUSTOM_TYPES_KEY,val);
      }
    });
  }catch(e){console.warn("Settings load failed:",e);}
}

// ── Telegram Settings ─────────────────────────────────────────────
function TelegramSettings({onClose,companyId}){
  const[token,setToken]=useState(()=>local.get(TG_KEY)?.token||"");
  const[chatId,setChatId]=useState(()=>local.get(TG_KEY)?.chatId||"");
  const[saved,setSaved]=useState(false);const[testRes,setTestRes]=useState(null);const[testing,setTesting]=useState(false);
  const save=()=>{const cfg={token:token.trim(),chatId:chatId.trim()};local.set(TG_KEY,cfg);saveSettingToFirestore(companyId,"telegram",cfg);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const test=async()=>{setTesting(true);setTestRes(null);const ok=await sendTelegram(token.trim(),chatId.trim(),"✅ <b>SiteShrimp</b>\nTelegram connected successfully!");setTestRes(ok?"success":"fail");setTesting(false);};
  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("telegram.title")}/>
      <div style={{padding:20}}>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
          {[["1","Open Telegram → search @BotFather → type /newbot → follow steps → copy the Bot Token"],["2","Create a group → add your bot as a member → promote it to Admin"],["3","Forward any message from the group to @userinfobot → it replies with Chat ID (negative number)"],["4","Paste both below → TEST → SAVE"]].map(([n,t])=>(
            <div key={n} style={{display:"flex",gap:10,marginBottom:12,alignItems:"flex-start"}}>
              <div style={{width:22,height:22,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
              <div style={{fontSize:13,color:"#444",lineHeight:1.6,paddingTop:2}}>{t}</div>
            </div>
          ))}
        </div>
        <div style={{marginBottom:14}}><label style={lbl()}>BOT TOKEN</label><input value={token} onChange={e=>setToken(e.target.value)} placeholder="123456789:AAFxxxx..." style={{...inp,width:"100%",flex:"unset"}}/></div>
        <div style={{marginBottom:20}}><label style={lbl()}>CHAT ID</label><input value={chatId} onChange={e=>setChatId(e.target.value)} placeholder="-1001234567890" style={{...inp,width:"100%",flex:"unset"}}/></div>
        {testRes&&<div style={{background:testRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${testRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:16,color:testRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>{testRes==="success"?"✓ Connected! Check your Telegram group.":"✗ Failed. Check token and Chat ID."}</div>}
        <div style={{display:"flex",gap:10}}>
          <button onClick={test} disabled={!token||!chatId||testing} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:13,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{testing?"TESTING...":"TEST"}</button>
          <button onClick={save} disabled={!token||!chatId} style={{flex:2,background:token&&chatId?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:13,color:token&&chatId?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
        </div>
      </div>
    </div>
  );
}

// ── AI Settings (multi-provider: Gemini, Ollama, OpenAI/GPT) ─────
const AI_PROVIDERS=[
  {id:"gemini",label:"Google Gemini",icon:"✦",desc:"Free cloud AI — 1,500 analyses/day",color:"#4285f4"},
  {id:"ollama",label:"Ollama (Local)",icon:"🦙",desc:"Run AI locally — Llava, Qwen, Llama Vision",color:"#30d158"},
  {id:"openai",label:"OpenAI / GPT",icon:"◈",desc:"GPT-4o, GPT-4o-mini, or compatible API",color:"#10a37f"},
];
function GeminiSettings({onClose,companyId}){
  const[provider,setProvider]=useState(()=>local.get(AI_PROVIDER_KEY)||"gemini");
  // Gemini state
  const[gemKey,setGemKey]=useState(()=>local.get(GEMINI_KEY)||"");
  // Ollama state
  const ollamaCfg=local.get(OLLAMA_KEY)||{url:"http://localhost:11434",model:"llava"};
  const[ollamaUrl,setOllamaUrl]=useState(ollamaCfg.url||"http://localhost:11434");
  const[ollamaModel,setOllamaModel]=useState(ollamaCfg.model||"llava");
  const[ollamaModels,setOllamaModels]=useState([]);
  // OpenAI state
  const openaiCfg=local.get(OPENAI_KEY)||{url:"https://api.openai.com",apiKey:"",model:"gpt-4o-mini"};
  const[oaiUrl,setOaiUrl]=useState(openaiCfg.url||"https://api.openai.com");
  const[oaiKey,setOaiKey]=useState(openaiCfg.apiKey||"");
  const[oaiModel,setOaiModel]=useState(openaiCfg.model||"gpt-4o-mini");
  // Shared state
  const[saved,setSaved]=useState(false);const[testing,setTesting]=useState(false);const[testRes,setTestRes]=useState(null);

  // Fetch available Ollama models when Ollama is selected
  useEffect(()=>{
    if(provider!=="ollama")return;
    const url=ollamaUrl.replace(/\/+$/,"");
    fetch(url+"/api/tags").then(r=>r.json()).then(d=>{
      const models=(d.models||[]).map(m=>m.name);
      setOllamaModels(models);
    }).catch(()=>setOllamaModels([]));
  },[provider,ollamaUrl]);

  const save=()=>{
    local.set(AI_PROVIDER_KEY,provider);
    if(provider==="gemini")local.set(GEMINI_KEY,gemKey.trim());
    if(provider==="ollama")local.set(OLLAMA_KEY,{url:ollamaUrl.trim(),model:ollamaModel.trim()});
    if(provider==="openai")local.set(OPENAI_KEY,{url:oaiUrl.trim(),apiKey:oaiKey.trim(),model:oaiModel.trim()});
    setSaved(true);setTimeout(()=>setSaved(false),2000);
  };

  const test=async()=>{
    setTesting(true);setTestRes(null);
    try{
      if(provider==="gemini"){
        // Probe the models list endpoint — works regardless of which specific
        // model versions the key has access to. Reset the cached model pick
        // so the next real call re-probes against this freshly-validated key.
        const key=gemKey.trim();
        const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
        if(r.ok){
          const d=await r.json();
          const flashModels=(d.models||[]).map(m=>(m.name||"").replace(/^models\//,"")).filter(n=>n.includes("flash"));
          local.del(GEMINI_MODEL_KEY);
          setTestRes({ok:true,detail:flashModels.length?`${flashModels.length} model${flashModels.length>1?"s":""} available (${flashModels[0]})`:"Key valid"});
        }else{
          let reason="";
          try{const d=await r.json();reason=d?.error?.message||"";}catch{}
          if(r.status===400)reason=reason||"Invalid key format";
          else if(r.status===403)reason=reason||"Generative Language API not enabled for this project";
          else if(r.status===404)reason=reason||"Endpoint not found — key may be for a different Google API";
          else reason=reason||`HTTP ${r.status}`;
          setTestRes({ok:false,detail:reason});
        }
      }else if(provider==="ollama"){
        const url=ollamaUrl.trim().replace(/\/+$/,"");
        const res=await fetch(url+"/api/tags");
        if(res.ok){
          const d=await res.json();
          const models=(d.models||[]).map(m=>m.name);
          setOllamaModels(models);
          setTestRes(models.length>0?{ok:true,detail:`${models.length} model${models.length>1?"s":""} available`}:{ok:false,detail:"No models installed — run `ollama pull llava`"});
        }else{setTestRes({ok:false,detail:`HTTP ${res.status} from ${url}`});}
      }else if(provider==="openai"){
        const url=oaiUrl.trim().replace(/\/+$/,"");
        const res=await fetch(url+"/v1/models",{headers:{"Authorization":"Bearer "+oaiKey.trim()}});
        if(res.ok)setTestRes({ok:true,detail:"Key valid"});
        else{
          let reason="";try{const d=await res.json();reason=d?.error?.message||"";}catch{}
          setTestRes({ok:false,detail:reason||`HTTP ${res.status}`});
        }
      }
    }catch(e){setTestRes({ok:false,detail:e.message||"Network error"});}
    setTesting(false);
  };

  const canTest=provider==="gemini"?!!gemKey:provider==="ollama"?!!ollamaUrl:!!(oaiKey&&oaiUrl);

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("ai.title")}/>
      <div style={{padding:20}}>

        {/* Provider selector */}
        <label style={lbl()}>AI PROVIDER</label>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
          {AI_PROVIDERS.map(p=>(
            <button key={p.id} onClick={()=>{setProvider(p.id);setTestRes(null);}} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`2px solid ${provider===p.id?p.color:"rgba(0,0,0,0.1)"}`,background:provider===p.id?p.color+"10":"#fff",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:20,flexShrink:0}}>{p.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,color:provider===p.id?p.color:"#1a1a1a"}}>{p.label.toUpperCase()}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginTop:2}}>{p.desc}</div>
              </div>
              {provider===p.id&&<span style={{color:p.color,fontWeight:800,fontSize:16}}>✓</span>}
            </button>
          ))}
        </div>

        {/* Gemini config */}
        {provider==="gemini"&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a",marginBottom:12}}>GOOGLE GEMINI SETUP</div>
            {[["1",<>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{color:"#4285f4",fontWeight:700,textDecoration:"underline"}}>aistudio.google.com</a> and sign in with Google</>],["2","Click Get API Key → Create API Key"],["3","Copy the key and paste below → Test → Save"]].map(([n,t])=>(
              <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:"#4285f4",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
                <div style={{fontSize:12,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
              </div>
            ))}
            <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:8,padding:"10px 12px",marginTop:8,marginBottom:14}}>
              <div style={{fontSize:12,color:"#1a7a35",fontWeight:600}}>Free — 1,500 photo analyses per day · No credit card</div>
            </div>
            <label style={lbl()}>GEMINI API KEY</label>
            <input value={gemKey} onChange={e=>setGemKey(e.target.value)} placeholder="AIzaSy..." type="password" style={{...inp,width:"100%",flex:"unset"}}/>
          </div>
        )}

        {/* Ollama config */}
        {provider==="ollama"&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a",marginBottom:12}}>OLLAMA LOCAL AI SETUP</div>
            {[["1","Install Ollama from ollama.com"],["2","Pull a vision model: ollama pull llava (or qwen2.5-vl, llama3.2-vision, minicpm-v)"],["3","Ollama runs at http://localhost:11434 by default"],["4","Enter your Ollama URL below → Test → Save"]].map(([n,t])=>(
              <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:"#30d158",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
                <div style={{fontSize:12,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
              </div>
            ))}
            <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:8,padding:"10px 12px",marginTop:8,marginBottom:14}}>
              <div style={{fontSize:12,color:"#1a7a35",fontWeight:600}}>Free and private — runs entirely on your machine · No data sent to cloud</div>
            </div>
            <label style={lbl()}>OLLAMA SERVER URL</label>
            <input value={ollamaUrl} onChange={e=>setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" style={{...inp,width:"100%",flex:"unset",marginBottom:14,fontFamily:"monospace",fontSize:13}}/>
            <label style={lbl()}>VISION MODEL</label>
            {ollamaModels.length>0?(
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                {ollamaModels.map(m=>(
                  <button key={m} onClick={()=>setOllamaModel(m)} style={{padding:"7px 12px",borderRadius:8,border:`1.5px solid ${ollamaModel===m?"#30d158":"rgba(0,0,0,0.1)"}`,background:ollamaModel===m?"rgba(48,209,88,0.1)":"#fff",color:ollamaModel===m?"#30d158":"#444",fontFamily:"monospace",fontSize:12,cursor:"pointer",fontWeight:ollamaModel===m?700:400}}>{m}</button>
                ))}
              </div>
            ):null}
            <input value={ollamaModel} onChange={e=>setOllamaModel(e.target.value)} placeholder="llava" style={{...inp,width:"100%",flex:"unset",fontFamily:"monospace",fontSize:13}}/>
            <div style={{fontSize:11,color:"rgba(0,0,0,0.35)",marginTop:6}}>
              Recommended vision models: llava, llava-llama3, qwen2.5-vl, llama3.2-vision, minicpm-v, bakllava
            </div>
          </div>
        )}

        {/* OpenAI / GPT config */}
        {provider==="openai"&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a",marginBottom:12}}>OPENAI / GPT SETUP</div>
            {[["1","Go to platform.openai.com → API Keys → Create new key"],["2","Copy the API key and paste below"],["3","Choose a vision-capable model (gpt-4o, gpt-4o-mini)"],["4","Or use any OpenAI-compatible API (e.g., local LM Studio, Together AI)"]].map(([n,t])=>(
              <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:"#10a37f",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
                <div style={{fontSize:12,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
              </div>
            ))}
            <label style={lbl()}>API BASE URL</label>
            <input value={oaiUrl} onChange={e=>setOaiUrl(e.target.value)} placeholder="https://api.openai.com" style={{...inp,width:"100%",flex:"unset",marginBottom:14,fontFamily:"monospace",fontSize:13}}/>
            <label style={lbl()}>API KEY</label>
            <input value={oaiKey} onChange={e=>setOaiKey(e.target.value)} placeholder="sk-..." type="password" style={{...inp,width:"100%",flex:"unset",marginBottom:14}}/>
            <label style={lbl()}>MODEL</label>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
              {["gpt-4o","gpt-4o-mini","gpt-4-turbo"].map(m=>(
                <button key={m} onClick={()=>setOaiModel(m)} style={{padding:"7px 12px",borderRadius:8,border:`1.5px solid ${oaiModel===m?"#10a37f":"rgba(0,0,0,0.1)"}`,background:oaiModel===m?"rgba(16,163,127,0.1)":"#fff",color:oaiModel===m?"#10a37f":"#444",fontFamily:"monospace",fontSize:12,cursor:"pointer",fontWeight:oaiModel===m?700:400}}>{m}</button>
              ))}
            </div>
            <input value={oaiModel} onChange={e=>setOaiModel(e.target.value)} placeholder="gpt-4o-mini" style={{...inp,width:"100%",flex:"unset",fontFamily:"monospace",fontSize:13}}/>
            <div style={{fontSize:11,color:"rgba(0,0,0,0.35)",marginTop:6}}>
              Works with OpenAI, Azure OpenAI, LM Studio, Together AI, or any OpenAI-compatible endpoint.
            </div>
          </div>
        )}

        {/* Test & Save */}
        {testRes&&(()=>{
          const ok=testRes.ok===true||testRes==="success";
          const detail=typeof testRes==="object"?testRes.detail:"";
          return(
            <div style={{background:ok?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${ok?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:16,color:ok?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>
              <div>{ok?"✓ AI connected! Photos will be auto-analyzed.":"✗ Connection failed."}</div>
              {detail&&<div style={{fontSize:11,fontWeight:500,marginTop:4,opacity:0.85,wordBreak:"break-word"}}>{detail}</div>}
              {!ok&&<div style={{fontSize:11,fontWeight:500,marginTop:6,opacity:0.75}}>Verify the key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{color:"#cc0000",textDecoration:"underline"}}>aistudio.google.com/apikey</a> — or check that Generative Language API is enabled in Google Cloud.</div>}
            </div>
          );
        })()}
        <div style={{display:"flex",gap:10}}>
          <button onClick={test} disabled={!canTest||testing} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:13,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{testing?"TESTING...":"TEST"}</button>
          <button onClick={save} disabled={!canTest} style={{flex:2,background:canTest?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:13,color:canTest?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
        </div>
      </div>
    </div>
  );
}

// ── SMTP Setup (in-app, no PocketBase admin needed) ──────────────
const SMTP_PRESETS=[
  {name:"Gmail",host:"smtp.gmail.com",port:587,hint:t("email.gmail_hint")},
  {name:"Outlook / Microsoft 365",host:"smtp.office365.com",port:587,hint:t("email.outlook_hint")},
  {name:"Yahoo",host:"smtp.mail.yahoo.com",port:587,hint:t("email.yahoo_hint")},
  {name:"Zoho",host:"smtp.zoho.com",port:587,hint:t("email.zoho_hint")},
  {name:t("email.custom_domain"),host:"",port:587,hint:t("email.custom_hint")},
];
const SMTP_KEY="sdt-smtp-v1";
function SmtpSetup(){
  const saved=local.get(SMTP_KEY)||{};
  const[provider,setProvider]=useState(saved.provider||"Gmail");
  const[email,setEmail]=useState(saved.email||"");
  const[password,setPassword]=useState(saved.password||"");
  const[host,setHost]=useState(saved.host||"smtp.gmail.com");
  const[port,setPort]=useState(saved.port||587);
  const[saving,setSaving]=useState(false);
  const[testing,setTesting]=useState(false);
  const[result,setResult]=useState(null);
  const[showPassword,setShowPassword]=useState(false);
  const preset=SMTP_PRESETS.find(p=>p.name===provider)||SMTP_PRESETS[0];
  const isCustom=provider===t("email.custom_domain");
  const pickProvider=(name)=>{
    setProvider(name);
    const p=SMTP_PRESETS.find(x=>x.name===name);
    if(p&&p.host){setHost(p.host);setPort(p.port);}
    setResult(null);
  };
  const canSave=email.trim()&&password.trim()&&host.trim();
  const saveSmtp=async()=>{
    if(!canSave)return;
    setSaving(true);setResult(null);
    try{
      await DB.configureSmtp(host,port,email,password,email,"SiteShrimp");
      local.set(SMTP_KEY,{provider,email,password,host,port,configured:true});
      setResult("saved");
    }catch(e){console.error(e);setResult("fail");}
    setSaving(false);setTimeout(()=>{if(result==="saved")setResult(null);},3000);
  };
  const testSmtp=async()=>{
    setTesting(true);setResult(null);
    try{
      await DB.testSmtp(email);
      setResult("test_ok");
    }catch(e){console.error(e);setResult("test_fail");}
    setTesting(false);
  };
  return(
    <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
      <div style={{fontSize:14,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:"#1a1a1a",marginBottom:12}}>{t("email.smtp_setup_title")}</div>
      <div style={{fontSize:12,color:"#666",lineHeight:1.5,marginBottom:14}}>{t("email.smtp_setup_desc")}</div>
      <label style={lbl()}>{t("email.provider")}</label>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
        {SMTP_PRESETS.map(p=>(
          <button key={p.name} onClick={()=>pickProvider(p.name)} style={{padding:"7px 14px",borderRadius:8,border:provider===p.name?"2px solid #ff6b00":"1.5px solid #ddd",background:provider===p.name?"rgba(255,107,0,0.06)":"#fff",fontSize:12,fontWeight:provider===p.name?700:500,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",color:provider===p.name?"#ff6b00":"#555"}}>{p.name}</button>
        ))}
      </div>
      {preset.hint&&<div style={{fontSize:11,color:"#888",marginBottom:12,background:"rgba(255,107,0,0.04)",borderRadius:8,padding:"8px 10px",lineHeight:1.5}} dangerouslySetInnerHTML={{__html:"💡 "+preset.hint}}/>}
      <label style={lbl()}>{t("email.your_email")}</label>
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder={t("email.email_placeholder")} type="email" style={{...inp,marginBottom:12}}/>
      <label style={lbl()}>{t("email.app_password")}</label>
      <div style={{position:"relative",marginBottom:12}}>
        <input value={password} onChange={e=>setPassword(e.target.value)} placeholder={t("email.password_placeholder")} type={showPassword?"text":"password"} style={{...inp,paddingRight:40}}/>
        <button onClick={()=>setShowPassword(!showPassword)} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#999"}}>{showPassword?"🙈":"👁"}</button>
      </div>
      {isCustom&&(<>
        <label style={lbl()}>SMTP HOST</label>
        <input value={host} onChange={e=>setHost(e.target.value)} placeholder="smtp.yourdomain.com" style={{...inp,marginBottom:12}}/>
        <label style={lbl()}>PORT</label>
        <input value={port} onChange={e=>setPort(parseInt(e.target.value)||587)} placeholder="587" type="number" style={{...inp,marginBottom:12,width:100}}/>
      </>)}
      <div style={{display:"flex",gap:8}}>
        <button onClick={saveSmtp} disabled={!canSave||saving} style={{flex:1,background:canSave?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:14,color:canSave?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer",opacity:saving?0.7:1}}>
          {saving?t("messages.saving"):result==="saved"?"✓ "+t("messages.saved"):t("actions.save")}
        </button>
        {local.get(SMTP_KEY)?.configured&&(
          <button onClick={testSmtp} disabled={testing} style={{padding:"14px 20px",background:"rgba(255,107,0,0.08)",border:"1.5px solid rgba(255,107,0,0.2)",borderRadius:10,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer",color:"#ff6b00",opacity:testing?0.7:1}}>
            {testing?t("messages.testing"):t("email.test_btn")}
          </button>
        )}
      </div>
      {result==="test_ok"&&<div style={{marginTop:10,padding:"10px 12px",background:"rgba(52,199,89,0.08)",borderRadius:8,fontSize:12,color:"#34c759",fontWeight:600}}>✓ {t("email.test_success")}</div>}
      {result==="test_fail"&&<div style={{marginTop:10,padding:"10px 12px",background:"rgba(255,59,48,0.08)",borderRadius:8,fontSize:12,color:"#ff3b30",fontWeight:600}}>✗ {t("email.test_fail")}</div>}
      {result==="fail"&&<div style={{marginTop:10,padding:"10px 12px",background:"rgba(255,59,48,0.08)",borderRadius:8,fontSize:12,color:"#ff3b30",fontWeight:600}}>✗ {t("email.save_fail")}</div>}
    </div>
  );
}

// ── Email Settings ────────────────────────────────────────────────
function EmailSettings({onClose,companyId}){
  const s=local.get(EMAIL_KEY)||{recipients:[""]};
  const[rec,setRec]=useState(s.recipients&&s.recipients.length?s.recipients:[""]);
  const[saved,setSaved]=useState(false);
  const save=()=>{const cfg={recipients:rec.filter(r=>r.trim())};local.set(EMAIL_KEY,cfg);saveSettingToFirestore(companyId,"email",cfg);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("email.title")}/>
      <div style={{padding:20}}>
        <SmtpSetup/>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
          <div style={{fontSize:13,color:"#444",lineHeight:1.6}}>
            {t("email.recipients_desc")}
          </div>
          <div style={{fontSize:12,color:"#888",marginTop:8,lineHeight:1.5,background:"rgba(255,107,0,0.05)",borderRadius:8,padding:"8px 10px"}}>
            💡 <b>{t("email.pdf_tip_title")}</b> {t("email.pdf_tip_desc")}
          </div>
        </div>
        <div style={{marginBottom:16}}>
          <label style={lbl()}>RECIPIENT EMAILS</label>
          {rec.map((r,i)=>(
            <div key={i} style={{display:"flex",gap:8,marginBottom:8}}>
              <input value={r} onChange={e=>setRec(prev=>prev.map((x,j)=>j===i?e.target.value:x))} placeholder="email@example.com" type="email" style={{...inp,flex:1}}/>
              {rec.length>1&&<button onClick={()=>setRec(prev=>prev.filter((_,j)=>j!==i))} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"0 12px",color:"#ff3b30",cursor:"pointer",fontSize:16}}>×</button>}
            </div>
          ))}
          <button onClick={()=>setRec(r=>[...r,""])} style={{background:"rgba(255,107,0,0.08)",border:"1.5px dashed rgba(255,107,0,0.3)",borderRadius:10,padding:"10px",width:"100%",color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>+ ADD RECIPIENT</button>
        </div>
        <button onClick={save} disabled={!rec.some(r=>r.trim())} style={{width:"100%",background:rec.some(r=>r.trim())?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:14,color:rec.some(r=>r.trim())?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
      </div>
    </div>
  );
}

// ── Storage Settings ──────────────────────────────────────────────
const STORAGE_MODES=[
  {id:"pocketbase",label:"PocketBase (Default)",icon:"🗄",desc:"Photos stored on your PocketBase server"},
  {id:"local",label:"Local Path",icon:"💾",desc:"Store photos to a folder on your server/machine"},
  {id:"gdrive",label:"Google Drive",icon:"☁",desc:"Store photos in your own Google Drive"},
];
function StorageSettings({onClose,companyId}){
  const storageCfg=local.get(STORAGE_KEY)||{mode:"pocketbase",localPath:"",gdriveClientId:""};
  const[mode,setMode]=useState(storageCfg.mode||"pocketbase");
  const[localPath,setLocalPath]=useState(storageCfg.localPath||"");
  const[gClientId,setGClientId]=useState(storageCfg.gdriveClientId||"");
  const[saved,setSaved]=useState(false);
  const[gdriveUser,setGdriveUser]=useState(null);
  const[gdriveConnecting,setGdriveConnecting]=useState(false);
  const[gdriveError,setGdriveError]=useState("");
  const[testingLocal,setTestingLocal]=useState(false);
  const[localTestRes,setLocalTestRes]=useState(null);

  // Check Google Drive connection on mount
  useEffect(()=>{
    if(storageCfg.gdriveClientId){
      GDrive.init(storageCfg.gdriveClientId);
      if(GDrive.isConnected()){
        GDrive.getUserInfo().then(u=>setGdriveUser(u)).catch(()=>{});
      }
    }
  },[]);

  const save=()=>{
    const cfg={mode,localPath:localPath.trim(),gdriveClientId:gClientId.trim()};
    local.set(STORAGE_KEY,cfg);
    if(cfg.gdriveClientId)GDrive.init(cfg.gdriveClientId);
    setSaved(true);
    setTimeout(()=>setSaved(false),2000);
  };

  const connectGDrive=async()=>{
    if(!gClientId.trim()){setGdriveError("Enter your Google Client ID first.");return;}
    setGdriveConnecting(true);setGdriveError("");
    try{
      GDrive.init(gClientId.trim());
      await GDrive.authorize();
      const user=await GDrive.getUserInfo();
      setGdriveUser(user);
      // Auto-save on successful connect
      const cfg={mode:"gdrive",localPath:localPath.trim(),gdriveClientId:gClientId.trim()};
      local.set(STORAGE_KEY,cfg);
      setMode("gdrive");
    }catch(e){
      setGdriveError(e.message||"Connection failed.");
    }
    setGdriveConnecting(false);
  };

  const disconnectGDrive=()=>{
    GDrive.disconnect();
    setGdriveUser(null);
    if(mode==="gdrive"){setMode("pocketbase");local.set(STORAGE_KEY,{...local.get(STORAGE_KEY),mode:"pocketbase"});}
  };

  const testLocalPath=async()=>{
    if(!localPath.trim())return;
    setTestingLocal(true);setLocalTestRes(null);
    try{
      // Test by calling PocketBase custom endpoint (if available) or just validate format
      const pbUrl=localStorage.getItem('pb_url')||'https://api.siteshrimp.org';
      const resp=await fetch(pbUrl.replace(/\/+$/,'')+'/api/storage/test',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path:localPath.trim()}),
      });
      if(resp.ok){setLocalTestRes("success");}
      else{setLocalTestRes("fail");}
    }catch{
      // If endpoint doesn't exist, just validate the path format
      const p=localPath.trim();
      if(p.length>2&&(p.includes('/')||p.includes('\\'))){
        setLocalTestRes("success");
      }else{
        setLocalTestRes("fail");
      }
    }
    setTestingLocal(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("storage.title")}/>
      <div style={{padding:20}}>
        {/* Info box */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
          <div style={{fontSize:13,color:"#444",lineHeight:1.6,marginBottom:8}}>Choose where to store your photos and files. Default uses your PocketBase server.</div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",lineHeight:1.5}}>
            <b>Local Path</b> — for self-hosted setups on your own server, laptop, or machine. Files are saved to the folder you specify.<br/>
            <b>Google Drive</b> — for mobile users who want cloud storage they control. Photos upload to your personal Drive.
          </div>
        </div>

        {/* Storage mode selector */}
        <label style={lbl()}>STORAGE MODE</label>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
          {STORAGE_MODES.map(m=>(
            <button key={m.id} onClick={()=>setMode(m.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`2px solid ${mode===m.id?"#ff6b00":"rgba(0,0,0,0.1)"}`,background:mode===m.id?"rgba(255,107,0,0.06)":"#fff",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:22,flexShrink:0}}>{m.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,color:mode===m.id?"#ff6b00":"#1a1a1a"}}>{m.label.toUpperCase()}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginTop:2}}>{m.desc}</div>
              </div>
              {mode===m.id&&<span style={{color:"#ff6b00",fontWeight:800,fontSize:16}}>✓</span>}
            </button>
          ))}
        </div>

        {/* Local Path config */}
        {mode==="local"&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a",marginBottom:12}}>LOCAL STORAGE PATH</div>
            <div style={{background:"rgba(255,149,0,0.08)",border:"1px solid rgba(255,149,0,0.2)",borderRadius:8,padding:"10px 12px",marginBottom:14}}>
              <div style={{fontSize:12,color:"#996600",lineHeight:1.5}}>Enter the full path to the folder on your server or machine where photos should be saved. Make sure the folder exists and is writable.</div>
            </div>
            <label style={lbl()}>FOLDER PATH</label>
            <input value={localPath} onChange={e=>setLocalPath(e.target.value)} placeholder={navigator.platform.includes("Win")?"C:\\SiteShrimp\\photos":"/home/user/siteshrimp/photos"} style={{...inp,width:"100%",flex:"unset",marginBottom:10,fontFamily:"monospace",fontSize:13}}/>
            <div style={{fontSize:11,color:"rgba(0,0,0,0.35)",marginBottom:14}}>
              Examples:<br/>
              Windows: C:\SiteShrimp\photos<br/>
              Linux/Mac: /opt/siteshrimp/photos
            </div>
            {localTestRes&&<div style={{background:localTestRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${localTestRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:14,color:localTestRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>{localTestRes==="success"?"✓ Path format looks valid. Files will be saved here.":"✗ Invalid path format. Check and try again."}</div>}
            <div style={{display:"flex",gap:10}}>
              <button onClick={testLocalPath} disabled={!localPath||testingLocal} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:13,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{testingLocal?"TESTING...":"TEST PATH"}</button>
            </div>
          </div>
        )}

        {/* Google Drive config */}
        {mode==="gdrive"&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a",marginBottom:12}}>GOOGLE DRIVE SETUP</div>
            <div style={{marginBottom:14}}>
              {[
                ["1","Go to console.cloud.google.com → Create or select a project"],
                ["2","Enable the Google Drive API"],
                ["3","Go to Credentials → Create OAuth 2.0 Client ID (Web application)"],
                ["4","Add your app URL as an Authorized redirect URI"],
                ["5","Copy the Client ID and paste below → Connect"],
              ].map(([n,t])=>(
                <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
                  <div style={{fontSize:12,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
                </div>
              ))}
            </div>
            <label style={lbl()}>GOOGLE CLIENT ID</label>
            <input value={gClientId} onChange={e=>setGClientId(e.target.value)} placeholder="123456789.apps.googleusercontent.com" style={{...inp,width:"100%",flex:"unset",marginBottom:10,fontSize:12}}/>

            {/* Connected state */}
            {gdriveUser&&(
              <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:"#30d158",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:14,flexShrink:0}}>{(gdriveUser.displayName||"G")[0]}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a7a35"}}>{gdriveUser.displayName||"Connected"}</div>
                  <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>{gdriveUser.emailAddress||"Google Drive connected"}</div>
                </div>
                <button onClick={disconnectGDrive} style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:8,padding:"6px 12px",color:"#cc0000",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>DISCONNECT</button>
              </div>
            )}

            {gdriveError&&<div style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:"12px 16px",marginBottom:14,color:"#cc0000",fontSize:13,fontWeight:600}}>{gdriveError}</div>}

            {!gdriveUser&&(
              <button onClick={connectGDrive} disabled={!gClientId||gdriveConnecting} style={{width:"100%",background:gClientId?"#4285f4":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:14,color:gClientId?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#fff"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff"/></svg>
                {gdriveConnecting?"CONNECTING...":"CONNECT GOOGLE DRIVE"}
              </button>
            )}

            <div style={{marginTop:12,fontSize:11,color:"rgba(0,0,0,0.3)",lineHeight:1.5}}>
              Photos will be saved in a "SiteShrimp Photos" folder in your Google Drive. Only you can access them unless you share the folder.
            </div>
          </div>
        )}

        {/* Google Sheets Integration */}
        <GoogleSheetsSetup gClientId={gClientId}/>

        {/* Save button */}
        <button onClick={save} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:14,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE SETTINGS"}</button>
      </div>
    </div>
  );
}

function GoogleSheetsSetup({gClientId}){
  const cfg=getGSheetConfig()||{};
  const[clientId,setClientId]=useState(cfg.clientId||"");
  const[saved,setSaved]=useState(false);
  const hasLinkedSheet=!!cfg.spreadsheetId;
  // Use Google Drive's Client ID if available and not manually set
  const effectiveId=clientId.trim()||gClientId||"";

  const save=()=>{
    saveGSheetConfig({...cfg,clientId:effectiveId});
    setSaved(true);setTimeout(()=>setSaved(false),2000);
  };

  const unlinkSheet=()=>{
    const c=getGSheetConfig()||{};
    delete c.spreadsheetId;
    saveGSheetConfig(c);
    window.location.reload();
  };

  return(
    <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <span style={{fontSize:20}}>📊</span>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#1a1a1a"}}>GOOGLE SHEETS EXPORT</div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>Export reports directly to Google Spreadsheets</div>
        </div>
      </div>
      <div style={{background:"rgba(52,168,83,0.06)",border:"1px solid rgba(52,168,83,0.15)",borderRadius:8,padding:"10px 12px",marginBottom:14}}>
        <div style={{fontSize:12,color:"#1a7a35",lineHeight:1.5}}>
          Uses the same Google Client ID as Google Drive. Export from the Report tab → Export ▾ → Google Sheets.
          {gClientId&&!clientId.trim()&&<><br/><b style={{color:"#34a853"}}>✓ Using Google Drive Client ID</b></>}
        </div>
      </div>
      {!gClientId&&(
        <>
          <label style={lbl()}>GOOGLE CLIENT ID</label>
          <input value={clientId} onChange={e=>setClientId(e.target.value)} placeholder="123456789.apps.googleusercontent.com" style={{...inp,width:"100%",flex:"unset",marginBottom:10,fontSize:12}}/>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.3)",marginBottom:12,lineHeight:1.5}}>
            Same Client ID used for Google Drive. Make sure Google Sheets API is also enabled in your Google Cloud project.
          </div>
        </>
      )}
      {hasLinkedSheet&&(
        <div style={{display:"flex",alignItems:"center",gap:10,background:"rgba(52,168,83,0.08)",border:"1px solid rgba(52,168,83,0.2)",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
          <span style={{fontSize:18}}>📗</span>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:"#1a7a35"}}>Spreadsheet linked</div>
            <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>New exports will add tabs to the existing spreadsheet</div>
          </div>
          <button onClick={()=>window.open(`https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}`,"_blank")} style={{background:"#34a853",border:"none",borderRadius:8,padding:"6px 12px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>OPEN</button>
          <button onClick={unlinkSheet} style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:8,padding:"6px 10px",color:"#cc0000",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>UNLINK</button>
        </div>
      )}
      <div style={{display:"flex",gap:8}}>
        <button onClick={save} disabled={!effectiveId} style={{flex:1,background:effectiveId?"#34a853":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:13,color:effectiveId?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────
function Dashboard({defects,onView,tgEnabled,aiEnabled,syncing,company,currentProject,member,onDrawings,queueCount,onSyncQueue,syncing2,onBulkDelete}){
  const[dbSelect,setDbSelect]=useState(false);
  const[dbSelectedIds,setDbSelectedIds]=useState(()=>new Set());
  const[dbBulkSaving,setDbBulkSaving]=useState(false);
  const canDashDelete=member?.role==="Admin"&&!!onBulkDelete;
  const dbToggle=id=>setDbSelectedIds(prev=>{const n=new Set(prev);if(n.has(id))n.delete(id);else n.add(id);return n;});
  const dbExit=()=>{setDbSelect(false);setDbSelectedIds(new Set());};
  const dbApplyDelete=async()=>{
    if(!dbSelectedIds.size)return;
    if(!confirm(`Permanently delete ${dbSelectedIds.size} entr${dbSelectedIds.size===1?"y":"ies"}?\n\nThis also removes their drawing pins and cannot be undone.`))return;
    setDbBulkSaving(true);
    try{
      const res=await onBulkDelete(Array.from(dbSelectedIds));
      alert(`Deleted ${res.ok} entr${res.ok===1?"y":"ies"}${res.failed?` · ${res.failed} failed`:""}.`);
      dbExit();
    }catch(e){alert("Bulk delete failed: "+e.message);}
    setDbBulkSaving(false);
  };
  const open=defects.filter(d=>d.status==="Open").length;
  const inprog=defects.filter(d=>d.status==="In Progress").length;
  const done=defects.filter(d=>d.status==="Done").length;
  const verified=defects.filter(d=>d.status==="Verified").length;
  const closed=defects.filter(d=>d.status==="Closed").length;
  const critical=defects.filter(d=>d.severity==="Critical"&&!["Verified","Closed"].includes(d.status)).length;
  const sevData=SEVERITY.map(s=>({s,count:defects.filter(d=>d.severity===s).length})).filter(x=>x.count>0);

  const Card=({label,value,color})=>(
    <div style={{flex:1,background:"#fff",borderRadius:14,padding:"14px 16px",borderTop:`3px solid ${color}`}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:800,color:"#1a1a1a",lineHeight:1}}>{value}</div>
      <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",marginTop:4}}>{label}</div>
    </div>
  );

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:"#1a1a1a"}}>{currentProject?.name||"OVERVIEW"}</div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>{company?.companyName} · {member?.name}</div>
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {syncing
            ?<div style={{display:"flex",alignItems:"center",gap:5,background:"rgba(255,149,0,0.1)",border:"1px solid rgba(255,149,0,0.25)",borderRadius:20,padding:"4px 10px"}}><Spin size={8}/><span style={{fontSize:10,fontWeight:700,color:"#ff9500",fontFamily:"'Barlow Condensed',sans-serif",marginLeft:4}}>SYNC</span></div>
            :<div style={{display:"flex",alignItems:"center",gap:4,background:"rgba(0,229,100,0.1)",border:"1px solid rgba(0,229,100,0.2)",borderRadius:20,padding:"4px 8px"}}><div style={{width:6,height:6,borderRadius:"50%",background:"#00e564",animation:"pulse 2s infinite"}}/><span style={{fontSize:10,fontWeight:700,color:"#00e564",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("dashboard.live")}</span></div>
          }
          {tgEnabled&&<div style={{background:"rgba(0,136,204,0.1)",border:"1px solid rgba(0,136,204,0.25)",borderRadius:20,padding:"4px 8px"}}><span style={{fontSize:10,fontWeight:700,color:"#0088cc",fontFamily:"'Barlow Condensed',sans-serif"}}>TG</span></div>}
          {aiEnabled&&<div style={{background:"rgba(88,86,214,0.1)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:20,padding:"4px 8px"}}><span style={{fontSize:10,fontWeight:700,color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif"}}>AI</span></div>}
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <Card label={t("status.open_short")} value={open} color="#ff3b30"/>
        <Card label={t("status.in_progress_short")} value={inprog} color="#ff9500"/>
        <Card label={t("status.done_short")} value={done} color="#34aadc"/>
        <Card label={t("status.verified_short")} value={verified} color="#30d158"/>
        <Card label={t("status.closed_short")} value={closed} color="#8e8e93"/>
      </div>

      {critical>0&&(
        <div style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.25)",borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:20}}>⚠️</div>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"#ff3b30",fontSize:14}}>{critical} {t("dashboard.critical_unresolved")}</div><div style={{fontSize:12,color:"rgba(0,0,0,0.5)"}}>{t("dashboard.requires_attention")}</div></div>
        </div>
      )}

      {queueCount>0&&(
        <button onClick={onSyncQueue} style={{width:"100%",background:"rgba(255,149,0,0.1)",border:"1px solid rgba(255,149,0,0.25)",borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left"}}>
          {syncing2?<Spin size={16}/>:<span style={{fontSize:20}}>📤</span>}
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"#ff9500",fontSize:14}}>{queueCount} {t("messages.queued_offline")}</div>
            <div style={{fontSize:12,color:"rgba(0,0,0,0.5)"}}>{syncing2?t("messages.syncing"):navigator.onLine?t("dashboard.tap_sync"):t("messages.will_sync")}</div>
          </div>
        </button>
      )}

      {sevData.length>0&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:12}}>{t("dashboard.by_severity")}</div>
          {sevData.map(({s,count})=>(
            <div key={s} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:SEV_COLOR[s]}}>{(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase()}</span>
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12}}>{count}</span>
              </div>
              <div style={{background:"rgba(0,0,0,0.06)",borderRadius:4,height:5,overflow:"hidden"}}>
                <div style={{background:SEV_COLOR[s],height:"100%",width:defects.length?`${(count/defects.length)*100}%`:"0%",borderRadius:4,transition:"width 0.5s ease"}}/>
              </div>
            </div>
          ))}
        </div>
      )}

<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em"}}>{t("dashboard.recent_entries")}</div>
        {canDashDelete&&defects.length>0&&(
          dbSelect
            ?<button onClick={dbExit} style={{background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:20,padding:"4px 10px",color:"rgba(0,0,0,0.55)",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.done")}</button>
            :<button onClick={()=>setDbSelect(true)} style={{background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.25)",borderRadius:20,padding:"4px 10px",color:"#ff3b30",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>SELECT</button>
        )}
      </div>
      {defects.length===0&&(
        <div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"40px 0",fontSize:14}}>
          {t("dashboard.no_defects")}{["Admin","Manager","Inspector"].includes(member?.role)?` ${t("dashboard.tap_log")}`:""}
        </div>
      )}
      {defects.slice(0,6).map((d,i)=>{
        const checked=dbSelectedIds.has(d.id);
        return(
        <div key={d.id} onClick={()=>dbSelect?dbToggle(d.id):onView(d)} className="anim" style={{animationDelay:`${i*0.05}s`,background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",borderLeft:`4px solid ${SEV_COLOR[d.severity]}`,outline:dbSelect&&checked?"2px solid #ff3b30":"none",display:"flex",gap:10,alignItems:"flex-start"}}>
          {dbSelect&&(
            <div style={{width:20,height:20,borderRadius:5,border:checked?"2px solid #ff3b30":"2px solid rgba(0,0,0,0.25)",background:checked?"#ff3b30":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:2}}>
              {checked&&<span style={{color:"#fff",fontSize:12,fontWeight:900}}>✓</span>}
            </div>
          )}
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,color:"#1a1a1a",flex:1,paddingRight:8}}>{d.title}</div>
              <StatusChip s={d.status}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {d.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(d.entryType),background:typeBg(d.entryType),padding:"2px 8px",borderRadius:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(d.entryType)} {tOpt(d.entryType).toUpperCase()}</span>}
              <SevChip s={d.severity}/>
              <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>📍 {d.location}</span>
              <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>→ {d.assignee}</span>
            </div>
          </div>
        </div>
      );})}
      {dbSelect&&dbSelectedIds.size>0&&(
        <div style={{position:"fixed",bottom:72,left:"50%",transform:"translateX(-50%)",width:"calc(100% - 24px)",maxWidth:406,background:"#1a1a1a",borderRadius:14,padding:"12px 14px",zIndex:60,boxShadow:"0 12px 40px rgba(0,0,0,0.4)",display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff"}}>{dbSelectedIds.size} SELECTED</div>
          <button onClick={dbApplyDelete} disabled={dbBulkSaving} style={{background:"rgba(255,59,48,0.25)",border:"1px solid rgba(255,59,48,0.55)",borderRadius:10,padding:"9px 16px",color:"#ff6b6b",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:dbBulkSaving?"wait":"pointer"}}>{dbBulkSaving?"…":"🗑 DELETE"}</button>
        </div>
      )}
    </div>
  );
}

// ── Log Entry (with AI + Batch + Multi-photo) ────────────────────
function LogDefect({member,company,currentProject,members,onSave,existingDefects=[],onViewEntry,onTagDrawing}){
  const savedWorkCat=local.get(WORK_CATEGORY_KEY)||"Building Defects (Landed)";
  const blank={title:"",location:"",severity:"Major",description:"",assignee:member?.name||"",photos:[],
    component:"",issue:"",locationLevel:"",locationZone:"",locationSubzone:"",locationGrid:"",
    workCategory:savedWorkCat,
    entryType:"Defect",dueDate:"",duration:"",costImpact:"",costResponsible:"",costAmount:"",costRemarks:""};
  const[form,setForm]=useState(blank);
  // Component groups shown — narrowed by the selected work category
  const activeComponentGroups=useMemo(()=>{
    const cat=WORK_CATEGORIES[form.workCategory];
    if(!cat)return COMPONENT_GROUPS;
    const out={};
    cat.groups.forEach(g=>{if(COMPONENT_GROUPS[g])out[g]=COMPONENT_GROUPS[g];});
    return out;
  },[form.workCategory]);

  const[saving,setSaving]=useState(false);const[analyzing,setAnalyzing]=useState(false);const[aiResult,setAiResult]=useState(null);
  const[count,setCount]=useState(0);const[last,setLast]=useState(null);const[showBatch,setShowBatch]=useState(false);
  const[showMoreDetails,setShowMoreDetails]=useState(false);
  const saveAndDoneRef=useRef(false);
  const[speakTranscript,setSpeakTranscript]=useState("");
  const[showTypeManager,setShowTypeManager]=useState(false);
  const[customTypes,setCustomTypes]=useState(()=>getCustomTypes());
  const[newTypeName,setNewTypeName]=useState("");
  const[markupIdx,setMarkupIdx]=useState(null);
  const fileRef=useRef();
  const speakVoice=useVoice();
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const aiReady=isAiConfigured();
  const assignees=members.length>0?members.map(m=>m.name):["Site Manager","Engineer","Contractor","QC Inspector","Safety Officer"];
  const MAX_PHOTOS=10;

  const handlePhoto=e=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length)return;
    const remaining=MAX_PHOTOS-form.photos.length;
    const toAdd=files.slice(0,remaining);
    toAdd.forEach(f=>{
      const r=new FileReader();
      r.onload=()=>setForm(prev=>{
        if(prev.photos.length>=MAX_PHOTOS)return prev;
        return{...prev,photos:[...prev.photos,r.result]};
      });
      r.readAsDataURL(f);
    });
    setAiResult(null);
    if(fileRef.current)fileRef.current.value="";
  };

  const removePhoto=idx=>setForm(f=>({...f,photos:f.photos.filter((_,i)=>i!==idx)}));

  const analyze=async()=>{
    if(!form.photos.length||!aiReady)return;
    const today=new Date().toISOString().slice(0,10);
    const aiUsage=local.get(AI_LIMIT_KEY)||{date:"",count:0};
    const todayCount=aiUsage.date===today?aiUsage.count:0;
    if(todayCount>=AI_DAILY_LIMIT){
      alert(`AI analysis limit reached (${AI_DAILY_LIMIT}/day).\n\nYou can still log entries manually.`);
      return;
    }
    setAnalyzing(true);
    try{
      const compressed=await compressPhoto(form.photos[0],600,0.7);
      const result=await analyzePhoto(compressed||form.photos[0]);
      if(result&&(result.title||result.description)){
        local.set(AI_LIMIT_KEY,{date:today,count:todayCount+1});
        setAiResult(result);
        if(result.title)set("title",result.title);
        if(result.severity&&SEVERITY.includes(result.severity))set("severity",result.severity);
        if(result.description)set("description",result.description);
        if(result.trade)set("component",result.trade);
        // Auto-escalate severity for high safety risk
        if(result.safety_risk&&result.safety_risk>=4&&result.severity!=="Critical"){
          set("severity","Critical");
          result.severity="Critical";
        }
        // Auto-suggest assignee from team members if AI provides a trade/role
        if(result.suggested_assignee&&assignees.length>0){
          const suggestion=result.suggested_assignee.toLowerCase();
          const match=assignees.find(a=>a.toLowerCase().includes(suggestion))||assignees.find(a=>suggestion.includes(a.toLowerCase()));
          if(match)set("assignee",match);
        }
      }else{
        alert("AI could not analyze the photo. Try a clearer image or log manually.");
      }
    }catch(e){alert("AI analysis error: "+e.message);}
    setAnalyzing(false);
  };

  // Duplicate detection — word overlap similarity
  const findDuplicate=(title,location)=>{
    if(!title||existingDefects.length===0)return null;
    const words=title.toLowerCase().split(/\s+/).filter(w=>w.length>2);
    if(words.length===0)return null;
    const openEntries=existingDefects.filter(d=>!["Verified","Closed"].includes(d.status));
    let bestMatch=null,bestScore=0;
    for(const d of openEntries){
      const dWords=(d.title||"").toLowerCase().split(/\s+/).filter(w=>w.length>2);
      if(dWords.length===0)continue;
      const overlap=words.filter(w=>dWords.includes(w)).length;
      const score=overlap/Math.max(words.length,dWords.length);
      // Boost score if same location
      const sameLocation=location&&d.location&&d.location.toLowerCase().includes(location.toLowerCase().split(" > ")[0]);
      const finalScore=sameLocation?score+0.2:score;
      if(finalScore>bestScore){bestScore=finalScore;bestMatch=d;}
    }
    return bestScore>=0.6?bestMatch:null;
  };

  const submit=async()=>{
    // Minimum: a description OR a photo OR a title — anything else can be filled in later via Review comments.
    const hasDesc=!!form.description.trim();
    const hasPhoto=(form.photos||[]).length>0;
    const hasTitle=!!form.title.trim();
    if(!hasTitle&&!hasDesc&&!hasPhoto){alert("Add a description or a photo to submit.");return;}

    // Build location display from hierarchy (may be empty — location is now optional)
    const locParts=[form.locationLevel,form.locationZone,form.locationSubzone,form.locationGrid].filter(Boolean);
    const locationDisplay=locParts.join(" > ")||form.location||"";

    // Auto-generate a title when user only supplied a description or photo
    let effectiveTitle=form.title.trim();
    if(!effectiveTitle){
      if(hasDesc){
        effectiveTitle=form.description.trim().split(/\s+/).slice(0,10).join(" ");
        if(form.description.trim().length>effectiveTitle.length)effectiveTitle+="…";
      }else if(hasPhoto){
        effectiveTitle=`Photo entry — ${new Date().toLocaleDateString("en-GB")}`;
      }
    }

    // Check for duplicates (only when we have a real title to compare)
    if(hasTitle){
      const dup=findDuplicate(form.title,locationDisplay);
      if(dup&&!confirm(`⚠️ Similar entry found:\n\n"${dup.title}"\n${dup.severity} · ${dup.status} · ${dup.location}\n${dup.defect_id||""}\n\nSubmit anyway?`))return;
    }

    setSaving(true);
    try{
      const compressed=[];
      for(const p of form.photos){
        const c=await compressPhoto(p);
        if(c)compressed.push(c);
      }
      const trade=COMPONENT_TRADE[form.component]||"";
      const saveResult=await onSave({
        ...form,
        title:effectiveTitle,
        location:locationDisplay||form.location,
        locationDisplay,
        photo:compressed[0]||null,
        extraPhotos:compressed.slice(1),
        projectId:currentProject?.id||"default",
        projectName:currentProject?.name||"",
        entryType:form.entryType||"Defect",
        trade,
        status:"Open",loggedBy:member?.name||"",
        loggedByRole:member?.role||"",
        createdAt:DB.serverTimestamp(),
        updatedAt:DB.serverTimestamp(),
        comments:[]
      });
      setLast({location:locationDisplay,assignee:form.assignee,severity:form.severity,
        locationLevel:form.locationLevel,locationZone:form.locationZone,component:form.component,
        workCategory:form.workCategory,queued:saveResult==="queued",
        savedEntry:saveResult&&saveResult!=="queued"?{...saveResult,title:effectiveTitle,location:locationDisplay||form.location,severity:form.severity,trade,status:"Open",assignee:form.assignee,loggedBy:member?.name||"",loggedByRole:member?.role||"",description:form.description,component:form.component,entryType:form.entryType||"Defect"}:null});
      setCount(c=>c+1);setForm(blank);setAiResult(null);setSpeakTranscript("");
      if(saveAndDoneRef.current){saveAndDoneRef.current=false;/* stay on form, batch screen not shown — parent tab switch handles "done" */}
      else{setShowBatch(true);}
    }catch(e){alert("Error saving: "+e.message);}
    setSaving(false);
  };

  // ── Custom type manager helpers ──
  const addCustomType=()=>{
    const name=newTypeName.trim();
    if(!name)return;
    // Check duplicates (defaults + custom)
    if(getAllEntryTypes().map(t=>t.toLowerCase()).includes(name.toLowerCase())){alert("Type already exists.");return;}
    const idx=customTypes.length;
    const newType={name,icon:CUSTOM_TYPE_ICONS[idx%CUSTOM_TYPE_ICONS.length],color:CUSTOM_TYPE_COLORS[idx%CUSTOM_TYPE_COLORS.length]};
    const updated=[...customTypes,newType];
    setCustomTypes(updated);saveCustomTypes(updated);
    saveSettingToFirestore(company?.companyId,"customEntryTypes",updated);
    setNewTypeName("");
  };
  const removeCustomType=(name)=>{
    const updated=customTypes.filter(t=>t.name!==name);
    setCustomTypes(updated);saveCustomTypes(updated);
    saveSettingToFirestore(company?.companyId,"customEntryTypes",updated);
    if(form.entryType===name)set("entryType","Defect");
  };
  const updateCustomTypeIcon=(name,icon)=>{
    const updated=customTypes.map(t=>t.name===name?{...t,icon}:t);
    setCustomTypes(updated);saveCustomTypes(updated);
    saveSettingToFirestore(company?.companyId,"customEntryTypes",updated);
  };
  const updateCustomTypeColor=(name,color)=>{
    const updated=customTypes.map(t=>t.name===name?{...t,color}:t);
    setCustomTypes(updated);saveCustomTypes(updated);
    saveSettingToFirestore(company?.companyId,"customEntryTypes",updated);
  };

  if(showTypeManager)return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.15s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>setShowTypeManager(false)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:20,padding:"7px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"#1a1a1a"}}>ENTRY TYPES</div>
      </div>

      {/* Default types (read-only) */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.08em",marginBottom:8}}>DEFAULT TYPES</div>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:20}}>
        {ENTRY_TYPES.map(t=>(
          <div key={t} style={{display:"flex",alignItems:"center",gap:10,background:"#fff",borderRadius:10,padding:"10px 14px",borderLeft:`4px solid ${ENTRY_TYPE_COLOR[t]}`}}>
            <span style={{fontSize:18}}>{ENTRY_TYPE_ICON[t]}</span>
            <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,flex:1}}>{t}</span>
            <span style={{fontSize:10,color:"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif"}}>BUILT-IN</span>
          </div>
        ))}
      </div>

      {/* Custom types */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.08em",marginBottom:8}}>CUSTOM TYPES ({customTypes.length})</div>
      {customTypes.length===0&&(
        <div style={{background:"rgba(0,0,0,0.03)",borderRadius:10,padding:"16px",textAlign:"center",marginBottom:14,fontSize:13,color:"rgba(0,0,0,0.35)"}}>No custom types yet. Add one below.</div>
      )}
      <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:20}}>
        {customTypes.map(t=>(
          <div key={t.name} style={{background:"#fff",borderRadius:10,padding:"10px 14px",borderLeft:`4px solid ${t.color}`,display:"flex",alignItems:"center",gap:8}}>
            {/* Icon picker */}
            <div style={{position:"relative"}}>
              <button onClick={(e)=>{const el=e.currentTarget.nextSibling;el.style.display=el.style.display==="none"?"flex":"none";}} style={{fontSize:18,background:"none",border:"1px solid rgba(0,0,0,0.1)",borderRadius:6,width:32,height:32,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{t.icon}</button>
              <div style={{display:"none",position:"absolute",top:36,left:0,background:"#fff",border:"1px solid rgba(0,0,0,0.15)",borderRadius:8,padding:6,gap:4,flexWrap:"wrap",width:160,zIndex:10,boxShadow:"0 4px 12px rgba(0,0,0,0.15)"}}>
                {CUSTOM_TYPE_ICONS.map((ic,i)=>(
                  <button key={i} onClick={(e)=>{updateCustomTypeIcon(t.name,ic);e.currentTarget.parentNode.style.display="none";}} style={{fontSize:16,background:t.icon===ic?"rgba(255,107,0,0.15)":"none",border:"none",borderRadius:4,width:28,height:28,cursor:"pointer"}}>{ic}</button>
                ))}
              </div>
            </div>
            <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,flex:1}}>{t.name}</span>
            {/* Color picker */}
            <div style={{display:"flex",gap:3}}>
              {CUSTOM_TYPE_COLORS.map(c=>(
                <button key={c} onClick={()=>updateCustomTypeColor(t.name,c)} style={{width:16,height:16,borderRadius:"50%",background:c,border:t.color===c?"2px solid #1a1a1a":"2px solid transparent",cursor:"pointer",padding:0}}/>
              ))}
            </div>
            <button onClick={()=>removeCustomType(t.name)} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:6,width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",color:"#ff3b30",cursor:"pointer",fontSize:14,fontWeight:700,flexShrink:0}}>×</button>
          </div>
        ))}
      </div>

      {/* Add new type */}
      <div style={{background:"#fff",borderRadius:12,padding:14}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.5)",marginBottom:8}}>ADD NEW TYPE</div>
        <div style={{display:"flex",gap:8}}>
          <input value={newTypeName} onChange={e=>setNewTypeName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCustomType()} placeholder="e.g. Site Checks, Safety Audit..." style={{...inp,flex:1}}/>
          <button onClick={addCustomType} disabled={!newTypeName.trim()} style={{background:newTypeName.trim()?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"0 18px",color:newTypeName.trim()?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer"}}>ADD</button>
        </div>
        <div style={{fontSize:11,color:"rgba(0,0,0,0.3)",marginTop:8}}>Custom types are shared across your team. Suggestions: Site Checks, Progress Update, Safety Audit, Handover, Snag List, RFI</div>
      </div>
    </div>
  );

  if(showBatch)return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.3)",borderRadius:14,padding:24,textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:8}}>{last?.queued?"📤":"✓"}</div>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:last?.queued?"#ff9500":"#1a7a35",marginBottom:4}}>{last?.queued?t("messages.queued_offline"):t("log.entry_logged")}</div>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)"}}>{count} logged this session · {last?.queued?"Will sync when online":"Team notified"}</div>
      </div>
      <div style={{background:"#fff",borderRadius:14,padding:14,marginBottom:12}}>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)",marginBottom:6}}>Log another at the same location?</div>
        <div style={{fontSize:12,color:"rgba(0,0,0,0.4)"}}>📍 {last?.location} · → {last?.assignee}</div>
      </div>
      {last?.savedEntry&&!last?.queued&&(
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          {onTagDrawing&&<button onClick={()=>{setShowBatch(false);onTagDrawing(last.savedEntry);}} style={{flex:1,background:"#5856d6",border:"none",borderRadius:12,padding:14,color:"#fff",fontSize:13,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>📐 TAG DRAWING</button>}
          {onViewEntry&&<button onClick={()=>{setShowBatch(false);onViewEntry(last.savedEntry);}} style={{flex:1,background:"#1a1a1a",border:"none",borderRadius:12,padding:14,color:"#fff",fontSize:13,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>✏️ EDIT DETAILS</button>}
        </div>
      )}
      <button onClick={()=>{setForm({...blank,
        workCategory:last?.workCategory||blank.workCategory,
        location:last?.location||"",assignee:last?.assignee||member?.name||"",severity:last?.severity||"Major",
        locationLevel:last?.locationLevel||"",locationZone:last?.locationZone||"",component:last?.component||""
      });setShowBatch(false);setSpeakTranscript("");setShowMoreDetails(false);}} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:12,padding:16,color:"#fff",fontSize:15,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>{t("log.log_another")}</button>
    </div>
  );

  const handleSpeakIssue=()=>{
    speakVoice.toggle(transcript=>{
      setSpeakTranscript(transcript);
      if(!form.title.trim())set("title",transcript.split(/\s+/).slice(0,10).join(" "));
      if(!form.description.trim())set("description",transcript);
    });
  };

  return(
    <div style={{padding:"20px 16px 120px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>{t("log.log_entry")}</div>
        {count>0&&<div style={{fontSize:10,fontWeight:700,color:"#30d158",background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>{count} {t("log.logged")}</div>}
        <div style={{fontSize:10,fontWeight:700,color:"#ff6b00",background:"rgba(255,107,0,0.1)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("log.quick_capture")}</div>
      </div>
      <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginBottom:20}}>📁 {currentProject?.name||"—"} · {t("log.photo_speak_type")}</div>

      {/* ── 1. TAKE PHOTO — big prominent capture ── */}
      <div style={{marginBottom:16}}>
        <label style={lbl()}>{t("log.photos_count")} ({form.photos.length}/{MAX_PHOTOS})</label>
        <input type="file" accept="image/*" capture="environment" multiple ref={fileRef} onChange={handlePhoto} style={{display:"none"}}/>
        {form.photos.length===0?(
          <button onClick={()=>fileRef.current.click()} style={{width:"100%",height:64,background:"#fff",border:"2px dashed rgba(0,0,0,0.18)",borderRadius:14,color:"rgba(0,0,0,0.5)",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>
            <span style={{fontSize:24}}>📷</span> {t("log.take_photo")}{aiReady?` · ${t("log.ai_auto_analyze")}`:""}
          </button>
        ):(
          <div>
            <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:8}}>
              {form.photos.map((p,i)=>(
                <div key={i} style={{position:"relative",flexShrink:0}}>
                  <img src={p} alt="" onClick={()=>setMarkupIdx(i)} style={{width:100,height:100,borderRadius:10,objectFit:"cover",cursor:"pointer"}}/>
                  <button onClick={()=>removePhoto(i)} style={{position:"absolute",top:4,right:4,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:22,height:22,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                  <div onClick={()=>setMarkupIdx(i)} style={{position:"absolute",bottom:4,left:4,background:"rgba(0,0,0,0.7)",borderRadius:10,padding:"2px 6px",color:"#fff",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>✏ {t("log.markup")}</div>
                </div>
              ))}
              {form.photos.length<MAX_PHOTOS&&(
                <button onClick={()=>fileRef.current.click()} style={{width:100,height:100,borderRadius:10,border:"2px dashed rgba(0,0,0,0.15)",background:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:24,color:"rgba(0,0,0,0.3)"}}>+</button>
              )}
            </div>
            {aiReady&&(
              <button onClick={analyze} disabled={analyzing} style={{width:"100%",background:"rgba(88,86,214,0.08)",border:"1.5px solid rgba(88,86,214,0.3)",borderRadius:10,padding:"11px",color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {analyzing?<><Spin size={14}/><span>{t("log.analyzing")}</span></>:<><span>🤖</span><span>{t("log.analyze_with_ai")}</span></>}
              </button>
            )}
            {!aiReady&&<div style={{fontSize:11,color:"rgba(0,0,0,0.35)",textAlign:"center",padding:"6px 0"}}>{t("log.setup_ai_tip")}</div>}
            {aiResult&&(
              <div style={{background:"rgba(88,86,214,0.06)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"10px 12px",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#5856d6",marginBottom:4,fontFamily:"'Barlow Condensed',sans-serif"}}>{t("log.ai_filled")}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.5)",marginBottom:6}}>{aiResult.description}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {aiResult.trade&&<span style={{fontSize:10,fontWeight:700,background:"rgba(88,86,214,0.1)",color:"#5856d6",padding:"2px 8px",borderRadius:10}}>🔧 {aiResult.trade}</span>}
                  {aiResult.suggested_assignee&&<span style={{fontSize:10,fontWeight:700,background:"rgba(255,107,0,0.1)",color:"#ff6b00",padding:"2px 8px",borderRadius:10}}>👤 → {aiResult.suggested_assignee}</span>}
                  {aiResult.safety_risk&&aiResult.safety_risk>=3&&<span style={{fontSize:10,fontWeight:700,background:aiResult.safety_risk>=4?"rgba(255,59,48,0.15)":"rgba(255,149,0,0.15)",color:aiResult.safety_risk>=4?"#ff3b30":"#ff9500",padding:"2px 8px",borderRadius:10}}>⚠️ Safety Risk: {aiResult.safety_risk}/5</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 2. SPEAK ISSUE — large voice capture ── */}
      {speakVoice.supported&&(
        <div style={{marginBottom:16}}>
          <button onClick={handleSpeakIssue} style={{width:"100%",height:54,background:speakVoice.listening?"rgba(255,59,48,0.1)":"rgba(255,107,0,0.08)",border:`2px solid ${speakVoice.listening?"rgba(255,59,48,0.4)":"rgba(255,107,0,0.25)"}`,borderRadius:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,transition:"all 0.2s",boxShadow:speakVoice.listening?"0 0 20px rgba(255,59,48,0.3)":"none"}}>
            <span style={{fontSize:22}}>{speakVoice.listening?"🔴":"🎙"}</span>
            <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:16,color:speakVoice.listening?"#ff3b30":"#ff6b00",letterSpacing:"0.06em"}}>{speakVoice.listening?t("log.listening"):t("log.tap_to_speak")}</span>
          </button>
          {speakTranscript&&(
            <div style={{marginTop:6,background:"rgba(255,107,0,0.05)",border:"1px solid rgba(255,107,0,0.15)",borderRadius:8,padding:"8px 10px",fontSize:12,color:"rgba(0,0,0,0.55)",fontStyle:"italic"}}>"{speakTranscript}"</div>
          )}
        </div>
      )}

      {/* ── 3. TITLE ── */}
      <VoiceField label={t("fields.title")} value={form.title} onChange={v=>set("title",v)} placeholder={t("fields.title_placeholder")}/>

      {/* ── 4. WHAT HAPPENED ── */}
      <VoiceField label={t("fields.what_happened")} value={form.description} onChange={v=>set("description",v)} placeholder={t("fields.description_placeholder")} multiline/>

      {/* ── 5. SEVERITY ── */}
      <ComboField label={t("fields.severity")} value={form.severity} onChange={v=>set("severity",v)} options={SEVERITY} placeholder={t("fields.severity_placeholder")} displayFn={sevDisplayFn}/>

      {/* ── MORE DETAILS accordion ── */}
      <button onClick={()=>setShowMoreDetails(!showMoreDetails)} style={{width:"100%",background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.08)",borderRadius:12,padding:"14px 16px",marginBottom:showMoreDetails?16:0,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}}>
        <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"rgba(0,0,0,0.55)",letterSpacing:"0.06em"}}>{t("log.more_details")}</span>
        <span style={{fontSize:12,color:"rgba(0,0,0,0.35)",transition:"transform 0.2s",transform:showMoreDetails?"rotate(180deg)":"rotate(0deg)"}}>▼</span>
      </button>

      {showMoreDetails&&(
        <div style={{animation:"fadeIn 0.2s ease",marginTop:showMoreDetails?0:0}}>
          {/* Work Category */}
          <ComboField label={t("fields.work_category")} value={form.workCategory} onChange={v=>{setForm(f=>({...f,workCategory:v,component:"",issue:""}));local.set(WORK_CATEGORY_KEY,v);}} options={Object.keys(WORK_CATEGORIES)} placeholder={t("fields.work_category_placeholder")} displayFn={workcatDisplayFn}/>

          {/* Entry Type */}
          <ComboField label={t("fields.entry_type")} value={form.entryType} onChange={v=>set("entryType",v)} options={getAllEntryTypes()} placeholder={t("fields.entry_type_placeholder")} displayFn={tOpt}/>
          <div style={{marginTop:-10,marginBottom:12}}><button onClick={()=>setShowTypeManager(true)} style={{background:"none",border:"none",fontSize:11,color:"rgba(255,107,0,0.7)",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,padding:0}}>⚙ Manage custom types</button></div>

          {/* Item / Part (was Component) */}
          <ComboField label={t("fields.item_part")} value={form.component} onChange={v=>{set("component",v);set("issue","");}} grouped={activeComponentGroups} placeholder={t("fields.item_part_placeholder")} displayFn={tOpt}/>

          {/* Issue (filtered by selected component) */}
          {form.component&&(
            <ComboField label={t("fields.issue")} value={form.issue} onChange={v=>{set("issue",v);if(!form.title)set("title",form.component+" — "+v);}} options={COMPONENT_ISSUES[form.component]||COMPONENT_ISSUES["General"]} placeholder={t("fields.issue_placeholder")} displayFn={tOpt}/>
          )}

          {/* Location hierarchy */}
          <ComboField label={t("fields.level_floor")} value={form.locationLevel} onChange={v=>set("locationLevel",v)} options={DEFAULT_LEVELS} placeholder={t("fields.level_floor_placeholder")} displayFn={tOpt}/>
          <ComboField label={t("fields.zone")} value={form.locationZone} onChange={v=>set("locationZone",v)} options={DEFAULT_ZONES} placeholder={t("fields.zone_placeholder")} displayFn={tOpt}/>
          <ComboField label={t("fields.room_area")} value={form.locationSubzone} onChange={v=>set("locationSubzone",v)} options={DEFAULT_SUBZONES} placeholder={t("fields.room_area_placeholder")} displayFn={tOpt}/>
          <VoiceField label={t("fields.grid_ref")} value={form.locationGrid} onChange={v=>set("locationGrid",v)} placeholder={t("fields.grid_ref_placeholder")}/>

          {/* Assignee */}
          <ComboField label={t("fields.assign_to")} value={form.assignee} onChange={v=>set("assignee",v)} options={assignees} placeholder={t("fields.assign_to_placeholder")}/>

          {/* Cost & Time */}
          <div style={{background:"rgba(0,0,0,0.02)",borderRadius:12,padding:14,marginBottom:16,border:"1px solid rgba(0,0,0,0.06)"}}>
            <div style={{marginBottom:12}}>
              <label style={lbl()}>{t("log.due_date")}</label>
              <input type="date" value={form.dueDate} onChange={e=>set("dueDate",e.target.value)} style={{...inp,width:"100%",flex:"unset"}}/>
            </div>
            <ComboField label={t("fields.time_needed")} value={form.duration} onChange={v=>set("duration",v)} options={DURATION_OPTIONS} placeholder={t("fields.time_needed_placeholder")} displayFn={tOpt}/>
            <ComboField label={t("fields.cost_change")} value={form.costImpact} onChange={v=>set("costImpact",v)} options={COST_IMPACT_OPTIONS} placeholder={t("fields.cost_change_placeholder")} displayFn={tOpt}/>
            {form.costImpact&&form.costImpact!=="No change"&&form.costImpact!=="To be confirmed by QS"&&(
              <>
                <VoiceField label={t("fields.cost_amount")} value={form.costAmount} onChange={v=>set("costAmount",v)} placeholder={t("fields.cost_amount_placeholder")}/>
                <ComboField label={t("fields.cost_responsible")} value={form.costResponsible} onChange={v=>set("costResponsible",v)} options={COST_RESPONSIBLE_OPTIONS} placeholder={t("fields.cost_responsible_placeholder")} displayFn={tOpt}/>
                <VoiceField label={t("fields.cost_remarks")} value={form.costRemarks} onChange={v=>set("costRemarks",v)} placeholder={t("fields.cost_remarks_placeholder")} multiline/>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 6. STICKY BOTTOM ACTION BAR ── */}
      {(()=>{
        const canSubmit=!!(form.title.trim()||form.description.trim()||(form.photos||[]).length>0);
        return(
          <div style={{position:"sticky",bottom:0,background:"rgba(240,237,232,0.97)",backdropFilter:"blur(8px)",padding:"12px 16px",borderTop:"1px solid rgba(0,0,0,0.08)",zIndex:10,margin:"0 -16px",width:"calc(100% + 32px)"}}>
            <button onClick={submit} disabled={saving||!canSubmit} style={{width:"100%",height:54,background:canSubmit&&!saving?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:14,color:canSubmit?"#fff":"rgba(0,0,0,0.3)",fontSize:16,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em",cursor:canSubmit&&!saving?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {saving?<><Spin size={16}/><span>{t("log.saving")}</span></>:t("log.save_next")}
            </button>
            <div style={{textAlign:"center",marginTop:8}}>
              <button onClick={()=>{saveAndDoneRef.current=true;submit();}} disabled={saving||!canSubmit} style={{background:"none",border:"none",fontSize:12,color:"rgba(0,0,0,0.4)",cursor:canSubmit&&!saving?"pointer":"not-allowed",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>{t("log.save_done")}</button>
            </div>
          </div>
        );
      })()}

      {/* Photo Markup Editor */}
      {markupIdx!==null&&form.photos[markupIdx]&&(
        <PhotoMarkup src={form.photos[markupIdx]}
          onSave={dataUrl=>{setForm(f=>({...f,photos:f.photos.map((p,i)=>i===markupIdx?dataUrl:p)}));setMarkupIdx(null);}}
          onCancel={()=>setMarkupIdx(null)}/>
      )}
    </div>
  );
}

// ── Highlight matching text ───────────────────────────────────────
function Highlight({text,query}){
  if(!query||!text)return text||"";
  const parts=String(text).split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`,"gi"));
  return parts.map((p,i)=>p.toLowerCase()===query.toLowerCase()?<mark key={i} style={{background:"rgba(255,107,0,0.3)",color:"#1a1a1a",borderRadius:2,padding:"0 1px"}}>{p}</mark>:p);
}

// ── Defects List ──────────────────────────────────────────────────
// ── AI Natural Language Search ───────────────────────────────────
const NL_SEARCH_PROMPT=`You are a search assistant for a construction defect tracking app. Convert the user's natural language query into structured JSON filters. Available fields:
- status: "Open","In Progress","Done","Verified","Closed" (or "All")
- severity: "Critical","Major","Minor","Observation" (or "All")
- entryType: "Defect","Check","Progress","Safety" (or custom types, or "All")
- search: free text to match against title, description, component, assignee, location
- summary: a brief natural language answer to show the user (1 sentence)

Respond ONLY with valid JSON, no markdown:
{"status":"All","severity":"All","entryType":"All","search":"","summary":""}

Examples:
- "critical plumbing defects" → {"status":"All","severity":"Critical","entryType":"Defect","search":"plumbing","summary":"Showing all critical plumbing defects"}
- "what's open in Block A?" → {"status":"Open","severity":"All","entryType":"All","search":"Block A","summary":"Showing all open entries in Block A"}
- "safety issues assigned to John" → {"status":"All","severity":"All","entryType":"Safety","search":"John","summary":"Showing safety entries assigned to John"}

User query: `;

function AiSearch({defects,onApplyFilters,onClose}){
  const[query,setQuery]=useState("");const[thinking,setThinking]=useState(false);
  const[messages,setMessages]=useState([{role:"ai",text:"Ask me anything about your entries. Try:\n• \"Show critical defects in Level 3\"\n• \"What's still open?\"\n• \"Plumbing issues assigned to KH\""}]);
  const scrollRef=useRef();
  const aiReady=isAiConfigured();

  useEffect(()=>{if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight;},[messages]);

  const search=async(text)=>{
    if(!text.trim())return;
    const q=text.trim();
    setMessages(m=>[...m,{role:"user",text:q}]);
    setQuery("");setThinking(true);

    // Try AI first
    if(aiReady){
      try{
        const raw=await askAI(NL_SEARCH_PROMPT+q);
        if(raw){
          const parsed=JSON.parse(raw.replace(/```json|```/g,"").trim());
          const count=defects.filter(d=>{
            if(parsed.status&&parsed.status!=="All"&&d.status!==parsed.status)return false;
            if(parsed.severity&&parsed.severity!=="All"&&d.severity!==parsed.severity)return false;
            if(parsed.entryType&&parsed.entryType!=="All"&&d.entryType!==parsed.entryType)return false;
            if(parsed.search){const hay=[d.title,d.description,d.component,d.assignee,d.location,d.loggedBy].filter(Boolean).join(" ").toLowerCase();if(!hay.includes(parsed.search.toLowerCase()))return false;}
            return true;
          }).length;
          setMessages(m=>[...m,{role:"ai",text:`${parsed.summary||"Here are your results."}\n\n📊 **${count} entries found**`,filters:parsed}]);
          setThinking(false);return;
        }
      }catch{}
    }

    // Fallback: simple keyword search
    const lower=q.toLowerCase();
    const count=defects.filter(d=>[d.title,d.description,d.component,d.assignee,d.location,d.severity,d.status,d.entryType].filter(Boolean).join(" ").toLowerCase().includes(lower)).length;
    setMessages(m=>[...m,{role:"ai",text:aiReady?`I couldn't parse that query. Falling back to keyword search.\n\n📊 **${count} entries matching "${q}"**`:`AI not configured. Using keyword search.\n\n📊 **${count} entries matching "${q}"**`,filters:{search:q,status:"All",severity:"All",entryType:"All"}}]);
    setThinking(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:400,display:"flex",flexDirection:"column"}}>
      <div style={{maxWidth:430,width:"100%",margin:"0 auto",display:"flex",flexDirection:"column",height:"100%"}}>
        {/* Header */}
        <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
          <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff"}}>{t("ai.search")}</div>
          {!aiReady&&<div style={{fontSize:10,color:"#ff9500",fontWeight:700}}>AI not configured</div>}
        </div>

        {/* Messages */}
        <div ref={scrollRef} style={{flex:1,overflowY:"auto",padding:16}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
              <div style={{maxWidth:"85%",background:m.role==="user"?"#ff6b00":"rgba(255,255,255,0.08)",borderRadius:m.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px",padding:"10px 14px"}}>
                <div style={{fontSize:13,color:"#fff",whiteSpace:"pre-wrap",lineHeight:1.5}}>{m.text.replace(/\*\*(.*?)\*\*/g,"$1")}</div>
                {m.filters&&<button onClick={()=>{onApplyFilters(m.filters);onClose();}} style={{marginTop:8,width:"100%",background:"rgba(255,107,0,0.2)",border:"1px solid rgba(255,107,0,0.4)",borderRadius:8,padding:"8px",color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>SHOW RESULTS →</button>}
              </div>
            </div>
          ))}
          {thinking&&<div style={{display:"flex",gap:8,alignItems:"center",color:"rgba(255,255,255,0.4)",fontSize:12}}><Spin size={14}/> Thinking...</div>}
        </div>

        {/* Input */}
        <div style={{padding:"12px 14px",borderTop:"1px solid rgba(255,255,255,0.1)",display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
          <MicBtn onResult={t=>{setQuery(t);search(t);}} currentValue={query}/>
          <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search(query)} placeholder="Ask about your entries..." style={{flex:1,padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
          <button onClick={()=>search(query)} disabled={thinking||!query.trim()} style={{background:query.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"12px 16px",color:query.trim()?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>ASK</button>
        </div>
      </div>
    </div>
  );
}

// Module-level cache of PDF-page-1 dataURLs keyed by file URL. Lets the same
// drawing thumbnail appear on many Review rows without re-rendering the PDF
// for each row. Bounded at a few MB; a full app reload clears it.
const _pdfThumbCache=new Map();
function _renderPdfThumbDataUrl(url){
  if(_pdfThumbCache.has(url))return _pdfThumbCache.get(url);
  const p=(async()=>{
    try{
      if(!window.pdfjsLib)return null;
      const pdfjsLib=window.pdfjsLib;
      if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
        pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      const doc=await pdfjsLib.getDocument(url).promise;
      const page=await doc.getPage(1);
      const viewport=page.getViewport({scale:0.6});
      const canvas=document.createElement("canvas");
      canvas.width=viewport.width;canvas.height=viewport.height;
      await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      return canvas.toDataURL("image/jpeg",0.72);
    }catch{return null;}
  })();
  _pdfThumbCache.set(url,p);
  return p;
}

// Small drawing thumbnail with a single pin dot overlaid at its saved
// fractional position. Mirrors MapThumb — same 62×62 visual footprint.
function DrawingPinThumb({drawing,pin,severity,title}){
  const[src,setSrc]=useState(null);
  const fileUrl=useMemo(()=>DB.fileUrl("drawings",drawing.id,drawing.file),[drawing.id,drawing.file]);
  const isPdf=/\.pdf$/i.test(drawing.file||"");
  useEffect(()=>{
    let cancelled=false;
    if(isPdf){
      Promise.resolve(_renderPdfThumbDataUrl(fileUrl)).then(dataUrl=>{if(!cancelled)setSrc(dataUrl||null);});
    }else{
      setSrc(fileUrl);
    }
    return()=>{cancelled=true;};
  },[fileUrl,isPdf]);
  const color=SEV_COLOR[severity]||"#8e8e93";
  return(
    <div style={{width:62,height:62,position:"relative",borderRadius:8,overflow:"hidden",flexShrink:0,background:"#f8f8f6",border:"1px solid rgba(0,0,0,0.08)"}} title={title||"Drawing pin"}>
      {src?<img src={src} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>:<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"rgba(0,0,0,0.25)"}}>📐</div>}
      {typeof pin?.x==="number"&&typeof pin?.y==="number"&&(
        <div style={{position:"absolute",left:`${pin.x}%`,top:`${pin.y}%`,transform:"translate(-50%,-50%)",width:12,height:12,borderRadius:"50%",background:color,border:"2px solid #fff",boxShadow:"0 0 0 1px rgba(0,0,0,0.35)"}}/>
      )}
    </div>
  );
}

// Dispatch: render MapThumb for GPS-pinned entries, DrawingPinThumb for
// entries pinned on a drawing, or nothing if neither applies.
function EntryThumb({defect,drawingByEntryId}){
  if(parseDefectCoords(defect))return <MapThumb defect={defect}/>;
  const link=drawingByEntryId&&drawingByEntryId[defect.id];
  if(link)return <DrawingPinThumb drawing={link.drawing} pin={link.pin} severity={defect.severity} title={`On drawing: ${link.drawing.name||""}`}/>;
  return null;
}

// Small map thumbnail for Review rows — single OSM tile with the pin dot
// overlaid at its exact fractional position. No external static-map service
// required, and img cross-origin is fine for display (we aren't exporting).
function MapThumb({defect}){
  const coords=parseDefectCoords(defect);
  if(!coords)return null;
  const z=Math.min(18,Math.max(14,defect.mapZoom||17));
  const n=2**z;
  const xRaw=((coords.lng+180)/360)*n;
  const latRad=coords.lat*Math.PI/180;
  const yRaw=((1-Math.asinh(Math.tan(latRad))/Math.PI)/2)*n;
  const xTile=Math.floor(xRaw),yTile=Math.floor(yRaw);
  const url=`https://tile.openstreetmap.org/${z}/${xTile}/${yTile}.png`;
  const xPct=(xRaw-xTile)*100,yPct=(yRaw-yTile)*100;
  const color=SEV_COLOR[defect.severity]||"#8e8e93";
  return(
    <div style={{width:62,height:62,position:"relative",borderRadius:8,overflow:"hidden",flexShrink:0,background:"#e5e3dc",border:"1px solid rgba(0,0,0,0.08)"}} title="Map location">
      <img src={url} alt="Map" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} onError={e=>{e.target.style.display="none";}}/>
      <div style={{position:"absolute",left:`${xPct}%`,top:`${yPct}%`,transform:"translate(-50%,-50%)",width:12,height:12,borderRadius:"50%",background:color,border:"2px solid #fff",boxShadow:"0 0 0 1px rgba(0,0,0,0.35)"}}/>
    </div>
  );
}

// SiteCam-style consolidated map: every GPS-pinned entry shown on one map,
// numbered + severity coloured, auto-fit to bounds, tap to open.
function DefectsMapView({defects,onView}){
  const mapRef=useRef(null);
  const mapObj=useRef(null);
  const[status,setStatus]=useState("loading");
  const pinned=(defects||[]).map(d=>({d,c:parseDefectCoords(d)})).filter(x=>x.c);
  useEffect(()=>{
    if(pinned.length===0||!mapRef.current)return;
    const provider=getMapProvider();
    let cancelled=false;
    (async()=>{
      if(provider==="gmaps"){
        try{await loadGoogleMaps(local.get(GMAPS_KEY)||"");}catch{setStatus("error");return;}
        if(cancelled||!window.google?.maps)return;
        const g=window.google.maps;
        const map=new g.Map(mapRef.current,{mapTypeId:"hybrid",streetViewControl:false,fullscreenControl:false,gestureHandling:"greedy"});
        mapObj.current=map;
        const bounds=new g.LatLngBounds();
        pinned.forEach(({d,c},i)=>{
          const color=SEV_COLOR[d.severity]||"#8e8e93";
          const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="rgba(0,0,0,0.6)" stroke="${color}" stroke-width="3"/><text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${i+1}</text></svg>`;
          const m=new g.Marker({position:c,map,icon:{url:"data:image/svg+xml;utf8,"+encodeURIComponent(svg),scaledSize:new g.Size(32,32),anchor:new g.Point(16,16)},title:`${i+1}. ${d.title||"Entry"}`});
          m.addListener("click",()=>onView(d));
          bounds.extend(c);
        });
        if(pinned.length===1)map.setCenter(pinned[0].c),map.setZoom(17);
        else map.fitBounds(bounds,40);
      }else{
        try{await waitForLeaflet();}catch{setStatus("error");return;}
        if(cancelled||!window.L||!mapRef.current)return;
        const L=window.L;
        const map=L.map(mapRef.current,{zoomControl:true}).setView([pinned[0].c.lat,pinned[0].c.lng],15);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,crossOrigin:"anonymous"}).addTo(map);
        mapObj.current=map;
        const group=[];
        pinned.forEach(({d,c},i)=>{
          const color=SEV_COLOR[d.severity]||"#8e8e93";
          const html=`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="rgba(0,0,0,0.6)" stroke="${color}" stroke-width="3"/><text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${i+1}</text></svg>`;
          const m=L.marker([c.lat,c.lng],{icon:L.divIcon({className:"",html,iconSize:[32,32],iconAnchor:[16,16]}),title:`${i+1}. ${d.title||"Entry"}`}).addTo(map);
          m.on("click",()=>onView(d));
          group.push([c.lat,c.lng]);
        });
        if(pinned.length>1)map.fitBounds(group,{padding:[40,40]});
      }
      setStatus("ready");
      setTimeout(()=>{try{if(provider==="gmaps")window.google.maps.event.trigger(mapObj.current,"resize");else mapObj.current.invalidateSize();}catch{}},100);
    })();
    return()=>{cancelled=true;if(mapObj.current&&mapObj.current.remove)try{mapObj.current.remove();}catch{}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[defects?.length]);
  if(pinned.length===0)return(
    <div style={{textAlign:"center",color:"rgba(0,0,0,0.4)",padding:"40px 20px",fontSize:13,background:"#fff",borderRadius:12}}>
      No entries have GPS coordinates yet. Drop pins in Tag on Map to see them here.
    </div>
  );
  return(
    <div style={{position:"relative",marginBottom:10,background:"#fff",borderRadius:12,overflow:"hidden",border:"1px solid rgba(0,0,0,0.08)"}}>
      <div ref={mapRef} style={{width:"100%",height:"min(65dvh,560px)",minHeight:320,background:"#e5e3dc"}}/>
      <div style={{position:"absolute",top:10,left:10,background:"rgba(26,26,26,0.85)",color:"#fff",padding:"6px 12px",borderRadius:16,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,pointerEvents:"none"}}>{pinned.length} pinned · tap a marker to open</div>
      {status==="error"&&<div style={{padding:20,color:"#ff3b30",textAlign:"center"}}>Could not load the map. Check your connection and provider in Settings → Maps.</div>}
    </div>
  );
}

function DefectsList({defects,onView,nlFilters,onClearNl,onAiSearch,aiEnabled,member,members,onBulkUpdate,onBulkDelete,company,currentProject}){
  const[filter,setFilter]=useState("All");const[sevF,setSevF]=useState("All");const[typeF,setTypeF]=useState("All");
  const[search,setSearch]=useState("");const[showFilters,setShowFilters]=useState(false);
  const searchRef=useRef(null);
  // Batch select / update
  const canBulk=["Admin","Manager","Inspector"].includes(member?.role);
  const canBulkDelete=member?.role==="Admin"&&!!onBulkDelete;
  const applyBulkDelete=async()=>{
    if(!selectedIds.size)return;
    if(!confirm(`Permanently delete ${selectedIds.size} entr${selectedIds.size===1?"y":"ies"}?\n\nThis also removes their drawing pins and cannot be undone.`))return;
    setBulkSaving(true);
    try{
      const res=await onBulkDelete(Array.from(selectedIds));
      alert(`Deleted ${res.ok} entr${res.ok===1?"y":"ies"}${res.failed?` · ${res.failed} failed`:""}.`);
      exitSelect();
    }catch(e){alert("Bulk delete failed: "+e.message);}
    setBulkSaving(false);
  };
  const[selectMode,setSelectMode]=useState(false);
  const[selectedIds,setSelectedIds]=useState(()=>new Set());
  const[showBulkPanel,setShowBulkPanel]=useState(false);
  const[showMapView,setShowMapView]=useState(false);
  const[bulkStatus,setBulkStatus]=useState("");
  const[bulkSeverity,setBulkSeverity]=useState("");
  const[bulkAssignee,setBulkAssignee]=useState("");
  const[bulkDuration,setBulkDuration]=useState("");
  const[bulkDueDate,setBulkDueDate]=useState("");
  const[bulkSaving,setBulkSaving]=useState(false);
  const exitSelect=()=>{setSelectMode(false);setSelectedIds(new Set());setShowBulkPanel(false);setBulkStatus("");setBulkSeverity("");setBulkAssignee("");setBulkDuration("");setBulkDueDate("");};
  const toggleId=id=>setSelectedIds(prev=>{const n=new Set(prev);if(n.has(id))n.delete(id);else n.add(id);return n;});
  const applyBulk=async()=>{
    const patch={};
    if(bulkStatus)patch.status=bulkStatus;
    if(bulkSeverity)patch.severity=bulkSeverity;
    if(bulkAssignee.trim())patch.assignee=bulkAssignee.trim();
    if(bulkDuration)patch.duration=bulkDuration;
    if(bulkDueDate)patch.dueDate=bulkDueDate;
    if(!Object.keys(patch).length){alert("Pick at least one field to update.");return;}
    setBulkSaving(true);
    try{
      const res=await onBulkUpdate(Array.from(selectedIds),patch);
      alert(`Updated ${res.ok} entr${res.ok===1?"y":"ies"}${res.failed?` · ${res.failed} failed`:""}.`);
      exitSelect();
    }catch(e){alert("Bulk update failed: "+e.message);}
    setBulkSaving(false);
  };

  // Load drawings + pins for this project so Review rows can show a small
  // drawing-with-pin thumbnail for entries pinned on a floor plan (parity
  // with the MapThumb shown for GPS-pinned entries).
  const[rvDrawings,setRvDrawings]=useState([]);
  const[rvPins,setRvPins]=useState([]);
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id){setRvDrawings([]);return;}
    DB.drawings.list(`companyId="${company.companyId}" && projectId="${currentProject.id}"`)
      .then(items=>setRvDrawings(items||[])).catch(()=>setRvDrawings([]));
  },[company?.companyId,currentProject?.id]);
  useEffect(()=>{
    if(!rvDrawings.length){setRvPins([]);return;}
    Promise.all(rvDrawings.map(d=>DB.pins.list(`drawingId="${d.id}"`).catch(()=>[])))
      .then(results=>setRvPins(results.flat())).catch(()=>setRvPins([]));
  },[rvDrawings]);
  const drawingByEntryId=useMemo(()=>{
    const byId={};
    const drawingMap={};rvDrawings.forEach(d=>{drawingMap[d.id]=d;});
    rvPins.forEach(p=>{
      if(byId[p.entryId])return; // keep first pin per entry
      const drawing=drawingMap[p.drawingId];
      if(drawing)byId[p.entryId]={drawing,pin:p};
    });
    return byId;
  },[rvDrawings,rvPins]);

  // Apply NL filters from AI search
  useEffect(()=>{
    if(!nlFilters)return;
    if(nlFilters.status&&nlFilters.status!=="All")setFilter(nlFilters.status);
    if(nlFilters.severity&&nlFilters.severity!=="All")setSevF(nlFilters.severity);
    if(nlFilters.entryType&&nlFilters.entryType!=="All")setTypeF(nlFilters.entryType);
    if(nlFilters.search)setSearch(nlFilters.search);
  },[nlFilters]);
  const allTypes=getAllEntryTypes();
  const usedTypes=[...new Set(defects.map(d=>d.entryType).filter(Boolean))];
  const typeFilterOptions=allTypes.filter(t=>usedTypes.includes(t));
  const q=search.trim().toLowerCase();
  const filtered=defects.filter(d=>{
    if(filter!=="All"&&d.status!==filter)return false;
    if(sevF!=="All"&&d.severity!==sevF)return false;
    if(typeF!=="All"&&d.entryType!==typeF)return false;
    if(q){
      const hay=[d.title,d.description,d.component,d.issue,d.assignee,d.location,d.loggedBy,d.entryType,d.defect_id].filter(Boolean).join(" ").toLowerCase();
      if(!hay.includes(q))return false;
    }
    return true;
  });
  const activeFilters=(filter!=="All"?1:0)+(sevF!=="All"?1:0)+(typeF!=="All"?1:0);
  const clearAll=()=>{setFilter("All");setSevF("All");setTypeF("All");setSearch("");if(onClearNl)onClearNl();};
  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,gap:8}}>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>REVIEW <span style={{color:"rgba(0,0,0,0.3)",fontSize:18}}>({filtered.length})</span></div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginTop:1}}>{selectMode?`${selectedIds.size} ${t("review.selected_tip")}`:t("review.triage_desc")}</div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
          {(activeFilters>0||q)&&!selectMode&&<button onClick={clearAll} style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:20,padding:"4px 10px",color:"#ff3b30",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.clear")} ({activeFilters+(q?1:0)})</button>}
          {canBulk&&onBulkUpdate&&(
            selectMode?(
              <button onClick={exitSelect} style={{background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:20,padding:"4px 10px",color:"rgba(0,0,0,0.55)",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.done")}</button>
            ):(
              <button onClick={()=>setSelectMode(true)} style={{background:"rgba(255,107,0,0.1)",border:"1px solid rgba(255,107,0,0.25)",borderRadius:20,padding:"4px 10px",color:"#ff6b00",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("review.select")}</button>
            )
          )}
        </div>
      </div>

      {/* Search bar + AI Search */}
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <div style={{position:"relative",flex:1}}>
          <div style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"rgba(0,0,0,0.3)",pointerEvents:"none"}}>🔍</div>
          <input ref={searchRef} value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("review.search_placeholder")} style={{...inp,width:"100%",flex:"unset",paddingLeft:34,paddingRight:search?34:12,fontSize:13}}/>
          {search&&<button onClick={()=>{setSearch("");searchRef.current?.focus();}} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"rgba(0,0,0,0.08)",border:"none",borderRadius:"50%",width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,color:"rgba(0,0,0,0.4)",padding:0}}>×</button>}
        </div>
        {onAiSearch&&<button onClick={onAiSearch} title={aiEnabled?"AI natural-language search":"Configure AI in Settings to enable"} disabled={!aiEnabled} style={{background:aiEnabled?"rgba(255,107,0,0.12)":"rgba(0,0,0,0.04)",border:`1px solid ${aiEnabled?"rgba(255,107,0,0.3)":"rgba(0,0,0,0.08)"}`,borderRadius:10,padding:"0 14px",fontSize:16,cursor:aiEnabled?"pointer":"not-allowed",color:aiEnabled?"#ff6b00":"rgba(0,0,0,0.25)",flexShrink:0}}>💬</button>}
      </div>

      {/* Filter toggle */}
      <button onClick={()=>setShowFilters(!showFilters)} style={{background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,padding:"8px 14px",marginBottom:showFilters?12:16,width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:"rgba(0,0,0,0.5)"}}>
        <span>{t("review.filters")} {activeFilters>0?`(${activeFilters} active)`:""}</span>
        <span style={{fontSize:10}}>{showFilters?"▲":"▼"}</span>
      </button>

      {showFilters&&(
        <div style={{marginBottom:16}}>
          {/* Type filter */}
          {typeFilterOptions.length>1&&(
            <div style={{marginBottom:10}}>
              <div style={lbl()}>{t("review.type_label")}</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {["All",...typeFilterOptions].map(t=>(
                  <button key={t} onClick={()=>setTypeF(t)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${typeF===t?(t==="All"?"#ff6b00":typeColor(t)):"rgba(0,0,0,0.12)"}`,background:typeF===t?(t==="All"?"#ff6b00":typeBg(t)):"#fff",color:typeF===t?(t==="All"?"#fff":typeColor(t)):"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t==="All"?"ALL":typeIcon(t)+" "+t.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}
          <div style={{marginBottom:10}}>
            <div style={lbl()}>{t("review.status_label")}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["All",...STATUS].map(s=>(
                <button key={s} onClick={()=>setFilter(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${filter===s?"#ff6b00":"rgba(0,0,0,0.12)"}`,background:filter===s?"#ff6b00":"#fff",color:filter===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s==="All"?"ALL":(STATUS_I18N[s]?t(STATUS_I18N[s]):s).toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={lbl()}>{t("severity.label")}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["All",...SEVERITY].map(s=>(
                <button key={s} onClick={()=>setSevF(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${sevF===s?"#1a1a1a":"rgba(0,0,0,0.12)"}`,background:sevF===s?"#1a1a1a":"#fff",color:sevF===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s==="All"?"ALL":(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Select-all helper when in select mode */}
      {selectMode&&filtered.length>0&&(
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,padding:"8px 12px",background:"rgba(255,107,0,0.06)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10}}>
          <button onClick={()=>setSelectedIds(new Set(filtered.map(d=>d.id)))} style={{background:"none",border:"none",color:"#ff6b00",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>SELECT ALL ({filtered.length})</button>
          <span style={{color:"rgba(0,0,0,0.15)"}}>|</span>
          <button onClick={()=>setSelectedIds(new Set())} style={{background:"none",border:"none",color:"rgba(0,0,0,0.5)",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.clear")}</button>
        </div>
      )}

      {/* View toggle: LIST | MAP (only show MAP if any entries have GPS coords) */}
      {(()=>{const pinnable=filtered.filter(d=>parseDefectCoords(d));if(pinnable.length===0)return null;return(
        <div style={{display:"flex",gap:4,padding:3,background:"rgba(0,0,0,0.05)",borderRadius:10,marginBottom:12,width:"max-content"}}>
          <button onClick={()=>setShowMapView(false)} style={{padding:"6px 14px",borderRadius:7,border:"none",background:!showMapView?"#fff":"transparent",color:!showMapView?"#1a1a1a":"rgba(0,0,0,0.5)",boxShadow:!showMapView?"0 1px 3px rgba(0,0,0,0.08)":"none",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>📋 LIST</button>
          <button onClick={()=>setShowMapView(true)} style={{padding:"6px 14px",borderRadius:7,border:"none",background:showMapView?"#fff":"transparent",color:showMapView?"#1a1a1a":"rgba(0,0,0,0.5)",boxShadow:showMapView?"0 1px 3px rgba(0,0,0,0.08)":"none",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>🗺 MAP ({pinnable.length})</button>
        </div>
      );})()}
      {showMapView&&<DefectsMapView defects={filtered} onView={onView}/>}
      {!showMapView&&filtered.length===0&&<div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"50px 0",fontSize:14}}>{q?t("review.no_matching")+" \""+search+"\"":t("review.no_entries")}</div>}
      {!showMapView&&filtered.map((d,i)=>{
        const checked=selectedIds.has(d.id);
        return(
        <div key={d.id} className="anim" style={{animationDelay:`${i*0.04}s`,background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",borderLeft:`4px solid ${SEV_COLOR[d.severity]}`,display:"flex",gap:12,alignItems:"flex-start",outline:selectMode&&checked?"2px solid #ff6b00":"none"}} onClick={()=>selectMode?toggleId(d.id):onView(d)}>
          {selectMode&&(
            <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${checked?"#ff6b00":"rgba(0,0,0,0.2)"}`,background:checked?"#ff6b00":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:2,color:"#fff",fontSize:13,fontWeight:800}}>{checked?"✓":""}</div>
          )}
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,color:"#1a1a1a",flex:1,paddingRight:8}}><Highlight text={d.title} query={q}/></div>
              <StatusChip s={d.status}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:4}}>
              {d.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(d.entryType),background:typeBg(d.entryType),padding:"2px 8px",borderRadius:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(d.entryType)} {tOpt(d.entryType).toUpperCase()}</span>}
              <SevChip s={d.severity}/>
              <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>📍 <Highlight text={d.location} query={q}/></span>
            </div>
            {q&&d.description&&d.description.toLowerCase().includes(q)&&(
              <div style={{fontSize:11,color:"rgba(0,0,0,0.45)",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><Highlight text={d.description.slice(0,100)} query={q}/></div>
            )}
            <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",display:"flex",justifyContent:"space-between"}}>
              <span>→ <Highlight text={d.assignee} query={q}/></span>
              <span>{d.created?new Date(d.created).toLocaleDateString():"Just now"}</span>
            </div>
          </div>
          <EntryThumb defect={d} drawingByEntryId={drawingByEntryId}/>
        </div>
        );
      })}

      {/* Bulk edit panel */}
      {selectMode&&showBulkPanel&&selectedIds.size>0&&(
        <div style={{position:"fixed",bottom:64,left:"50%",transform:"translateX(-50%)",width:"calc(100% - 24px)",maxWidth:406,background:"#fff",border:"1px solid rgba(0,0,0,0.1)",borderRadius:14,padding:14,zIndex:60,boxShadow:"0 12px 40px rgba(0,0,0,0.25)",maxHeight:"60vh",overflowY:"auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#1a1a1a"}}>UPDATE {selectedIds.size} ENTR{selectedIds.size>1?"IES":"Y"}</div>
            <button onClick={()=>setShowBulkPanel(false)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:"50%",width:24,height:24,cursor:"pointer",fontSize:14,color:"rgba(0,0,0,0.5)"}}>×</button>
          </div>
          <div style={{fontSize:10,color:"rgba(0,0,0,0.4)",marginBottom:10,fontStyle:"italic"}}>Blank fields are not changed. Picked values overwrite all selected entries.</div>

          <div style={{marginBottom:10}}>
            <div style={lbl()}>STATUS</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["",...STATUS].map(s=>(
                <button key={s||"_none"} onClick={()=>setBulkStatus(s)} style={{padding:"6px 10px",borderRadius:18,border:`1.5px solid ${bulkStatus===s?(s?STATUS_COLOR[s]:"rgba(0,0,0,0.3)"):"rgba(0,0,0,0.12)"}`,background:bulkStatus===s?(s?STATUS_COLOR[s]:"rgba(0,0,0,0.08)"):"#fff",color:bulkStatus===s?(s?"#fff":"rgba(0,0,0,0.6)"):"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{s?s.toUpperCase():"— KEEP"}</button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:10}}>
            <div style={lbl()}>{t("severity.label")}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["",...SEVERITY].map(s=>(
                <button key={s||"_none"} onClick={()=>setBulkSeverity(s)} style={{padding:"6px 10px",borderRadius:18,border:`1.5px solid ${bulkSeverity===s?(s?SEV_COLOR[s]:"rgba(0,0,0,0.3)"):"rgba(0,0,0,0.12)"}`,background:bulkSeverity===s?(s?SEV_COLOR[s]:"rgba(0,0,0,0.08)"):"#fff",color:bulkSeverity===s?(s?"#fff":"rgba(0,0,0,0.6)"):"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{s?(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase():"— KEEP"}</button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:10}}>
            <div style={lbl()}>DURATION</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              <button onClick={()=>setBulkDuration("")} style={{padding:"6px 10px",borderRadius:18,border:`1.5px solid ${bulkDuration===""?"rgba(0,0,0,0.3)":"rgba(0,0,0,0.12)"}`,background:bulkDuration===""?"rgba(0,0,0,0.08)":"#fff",color:"rgba(0,0,0,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>— KEEP</button>
              {DURATION_OPTIONS.map(d=>(
                <button key={d} onClick={()=>setBulkDuration(d)} style={{padding:"6px 10px",borderRadius:18,border:`1.5px solid ${bulkDuration===d?"#ff6b00":"rgba(0,0,0,0.12)"}`,background:bulkDuration===d?"rgba(255,107,0,0.08)":"#fff",color:bulkDuration===d?"#ff6b00":"rgba(0,0,0,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{tOpt(d)}</button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:10}}>
            <div style={lbl()}>ASSIGNEE</div>
            <input list="bulk-assignees" value={bulkAssignee} onChange={e=>setBulkAssignee(e.target.value)} placeholder="Keep existing (blank = no change)" style={{...inp,width:"100%",flex:"unset"}}/>
            <datalist id="bulk-assignees">
              {(members||[]).map(m=><option key={m.id||m.name} value={m.name}/>)}
            </datalist>
          </div>

          <div style={{marginBottom:14}}>
            <div style={lbl()}>TARGET DATE</div>
            <input type="date" value={bulkDueDate} onChange={e=>setBulkDueDate(e.target.value)} style={{...inp,width:"100%",flex:"unset"}}/>
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setShowBulkPanel(false)} disabled={bulkSaving} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"12px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
            <button onClick={applyBulk} disabled={bulkSaving} style={{flex:2,background:"#ff6b00",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>{bulkSaving?<><Spin size={14}/> APPLYING…</>:`APPLY TO ${selectedIds.size}`}</button>
          </div>
        </div>
      )}

      {/* Sticky action bar when items selected */}
      {selectMode&&selectedIds.size>0&&!showBulkPanel&&(
        <div style={{position:"fixed",bottom:72,left:"50%",transform:"translateX(-50%)",width:"calc(100% - 24px)",maxWidth:406,background:"#1a1a1a",borderRadius:14,padding:"12px 14px",zIndex:60,boxShadow:"0 12px 40px rgba(0,0,0,0.4)",display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff"}}>{selectedIds.size} SELECTED</div>
          {canBulkDelete&&<button onClick={applyBulkDelete} disabled={bulkSaving} style={{background:"rgba(255,59,48,0.2)",border:"1px solid rgba(255,59,48,0.5)",borderRadius:10,padding:"9px 14px",color:"#ff6b6b",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:bulkSaving?"wait":"pointer"}}>{bulkSaving?"…":"🗑 DELETE"}</button>}
          <button onClick={()=>setShowBulkPanel(true)} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"9px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>UPDATE ▸</button>
        </div>
      )}
    </div>
  );
}

// ── Defect Detail ─────────────────────────────────────────────────
// ── Before/After Photo Comparison ────────────────────────────────
function BeforeAfter({before,after,onMarkup}){
  const[split,setSplit]=useState(50);
  const[mode,setMode]=useState("slider"); // slider | side
  const[imgRatio,setImgRatio]=useState(0.75);
  const containerRef=useRef();
  const onMove=e=>{
    const rect=containerRef.current.getBoundingClientRect();
    const pointer=e.touches?e.touches[0]:e;
    const x=Math.max(5,Math.min(95,((pointer.clientX-rect.left)/rect.width)*100));
    setSplit(x);
  };
  // Detect aspect ratio from before image for proper height
  useEffect(()=>{
    const img=new Image();
    img.onload=()=>setImgRatio(img.height/img.width);
    img.src=before;
  },[before]);
  return(
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em"}}>{t("compare.before")} / {t("compare.after")}</div>
        <div style={{display:"flex",gap:4}}>
          <button onClick={()=>setMode(m=>m==="slider"?"side":"slider")} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>{mode==="slider"?"⊞ SIDE":"⇔ SLIDER"}</button>
        </div>
      </div>
      {mode==="slider"?(
        <div ref={containerRef} style={{position:"relative",width:"100%",paddingBottom:`${Math.min(imgRatio*100,120)}%`,borderRadius:12,overflow:"hidden",cursor:"col-resize",touchAction:"none",background:"#f8f8f6"}}
          onMouseMove={e=>e.buttons===1&&onMove(e)} onTouchMove={onMove}>
          {/* After (full) */}
          <img src={after} alt="After" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain"}}/>
          {/* Before (clipped) */}
          <div style={{position:"absolute",inset:0,width:`${split}%`,overflow:"hidden"}}>
            <img src={before} alt="Before" style={{width:containerRef.current?.clientWidth||"100%",height:"100%",objectFit:"contain"}}/>
          </div>
          {/* Slider line */}
          <div style={{position:"absolute",top:0,bottom:0,left:`${split}%`,width:3,background:"#fff",transform:"translateX(-50%)",boxShadow:"0 0 8px rgba(0,0,0,0.5)"}}>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:28,height:28,borderRadius:"50%",background:"#fff",boxShadow:"0 2px 8px rgba(0,0,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#1a1a1a"}}>⇔</div>
          </div>
          {/* Labels */}
          <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.6)",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("compare.before")}</div>
          <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("compare.after")}</div>
        </div>
      ):(
        /* Side-by-side mode — full photos with markup buttons */
        <div style={{display:"flex",gap:6}}>
          {[{src:before,label:t("compare.before"),which:"before"},{src:after,label:t("compare.after"),which:"after"}].map(p=>(
            <div key={p.which} style={{flex:1,position:"relative"}}>
              <img src={p.src} alt={p.label} style={{width:"100%",borderRadius:10,objectFit:"contain",display:"block",background:"#f8f8f6"}}/>
              <div style={{position:"absolute",top:6,left:6,background:"rgba(0,0,0,0.6)",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>{p.label}</div>
              {onMarkup&&<button onClick={()=>onMarkup(p.which)} style={{position:"absolute",bottom:6,right:6,background:"rgba(255,107,0,0.85)",border:"none",borderRadius:8,padding:"5px 10px",fontSize:10,fontWeight:800,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",letterSpacing:"0.05em",boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>✏ MARKUP</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Full-screen Photo Viewer with zoom/pan ──────────────────────
function PhotoViewer({src,onClose}){
  const[scale,setScale]=useState(1);
  const[pan,setPan]=useState({x:0,y:0});
  const[dragging,setDragging]=useState(false);
  const lastPos=useRef({x:0,y:0});
  const lastDist=useRef(0);
  const zoomIn=()=>setScale(s=>Math.min(s+0.5,5));
  const zoomOut=()=>setScale(s=>Math.max(s-0.5,0.5));
  const resetZoom=()=>{setScale(1);setPan({x:0,y:0});};
  const onWheel=e=>{e.preventDefault();setScale(s=>Math.max(0.5,Math.min(5,s+(e.deltaY<0?0.3:-0.3))));};
  const onPointerDown=e=>{setDragging(true);lastPos.current={x:e.clientX-pan.x,y:e.clientY-pan.y};};
  const onPointerMove=e=>{if(!dragging)return;setPan({x:e.clientX-lastPos.current.x,y:e.clientY-lastPos.current.y});};
  const onPointerUp=()=>setDragging(false);
  const onTouchStart=e=>{if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX;const dy=e.touches[0].clientY-e.touches[1].clientY;lastDist.current=Math.sqrt(dx*dx+dy*dy);}};
  const onTouchMove=e=>{if(e.touches.length===2){e.preventDefault();const dx=e.touches[0].clientX-e.touches[1].clientX;const dy=e.touches[0].clientY-e.touches[1].clientY;const dist=Math.sqrt(dx*dx+dy*dy);if(lastDist.current){const delta=(dist-lastDist.current)*0.01;setScale(s=>Math.max(0.5,Math.min(5,s+delta)));}lastDist.current=dist;}};
  // Double-tap to reset
  const lastTap=useRef(0);
  const onDoubleTap=()=>{const now=Date.now();if(now-lastTap.current<300){resetZoom();}lastTap.current=now;};
  return(
    <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.92)",display:"flex",flexDirection:"column",animation:"fadeIn 0.2s ease"}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      {/* Top bar */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",flexShrink:0}}>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={zoomOut} style={{background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:16,cursor:"pointer",fontWeight:700}}>−</button>
          <button onClick={resetZoom} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"8px 12px",color:"#fff",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,minWidth:50}}>{Math.round(scale*100)}%</button>
          <button onClick={zoomIn} style={{background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:16,cursor:"pointer",fontWeight:700}}>+</button>
        </div>
        <button onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",borderRadius:10,padding:"8px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>✕ CLOSE</button>
      </div>
      {/* Photo area */}
      <div style={{flex:1,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",touchAction:"none",cursor:dragging?"grabbing":"grab"}}
        onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onClick={onDoubleTap}>
        <img src={src} alt="" style={{maxWidth:"90vw",maxHeight:"85vh",objectFit:"contain",transform:`scale(${scale}) translate(${pan.x/scale}px,${pan.y/scale}px)`,transition:dragging?"none":"transform 0.15s ease",userSelect:"none",pointerEvents:"none"}}/>
      </div>
      <div style={{textAlign:"center",padding:"8px",color:"rgba(255,255,255,0.4)",fontSize:11,fontFamily:"'Barlow Condensed',sans-serif"}}>Scroll or pinch to zoom · Drag to pan · Double-tap to reset</div>
    </div>
  );
}

// Parse a "Map: lat, lng" (or any "N.N, N.N") pair out of a defect's
// location / description when dedicated lat/lng fields are missing.
function parseDefectCoords(d){
  let lat=typeof d?.lat==="number"?d.lat:null;
  let lng=typeof d?.lng==="number"?d.lng:null;
  if(lat==null||lng==null){
    const src=(d?.location||"")+" "+(d?.description||"");
    const m=src.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if(m){lat=parseFloat(m[1]);lng=parseFloat(m[2]);}
  }
  if(lat==null||lng==null||isNaN(lat)||isNaN(lng))return null;
  return{lat,lng};
}

// Live mini-map in the entry detail — shows this pin prominently plus
// every nearby GPS-pinned entry as numbered coloured markers (SiteCam-style
// project overview in miniature).
function DefectMiniMap({defect,allDefects}){
  const mapRef=useRef(null);
  const mapObj=useRef(null);
  const[status,setStatus]=useState("loading");
  const coords=parseDefectCoords(defect);
  // Persist parsed coords back to the record so map list & export pick them up
  useEffect(()=>{
    if(!coords)return;
    if(typeof defect.lat!=="number"||typeof defect.lng!=="number"){
      DB.defects.update(defect.id,{lat:coords.lat,lng:coords.lng,mapZoom:defect.mapZoom||17}).catch(()=>{});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[defect.id]);

  useEffect(()=>{
    if(!coords||!mapRef.current)return;
    const provider=getMapProvider();
    let cancelled=false;
    (async()=>{
      if(provider==="gmaps"){
        try{await loadGoogleMaps(local.get(GMAPS_KEY)||"");}
        catch{setStatus("error");return;}
        if(cancelled||!window.google?.maps)return;
        const g=window.google.maps;
        const map=new g.Map(mapRef.current,{
          center:{lat:coords.lat,lng:coords.lng},
          zoom:defect.mapZoom||17,
          mapTypeId:"hybrid",
          streetViewControl:false,mapTypeControl:false,fullscreenControl:false,zoomControl:true,
          gestureHandling:"cooperative",
        });
        mapObj.current=map;
        placeMarkers(g,map,coords);
      }else{
        try{await waitForLeaflet();}catch{setStatus("error");return;}
        if(cancelled||!window.L||!mapRef.current)return;
        const L=window.L;
        const map=L.map(mapRef.current,{zoomControl:true,attributionControl:false,scrollWheelZoom:false}).setView([coords.lat,coords.lng],defect.mapZoom||17);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,crossOrigin:"anonymous"}).addTo(map);
        mapObj.current=map;
        placeLeafletMarkers(L,map,coords);
      }
      setStatus("ready");
      setTimeout(()=>{try{if(provider==="gmaps")window.google.maps.event.trigger(mapObj.current,"resize");else mapObj.current.invalidateSize();}catch{}},80);
    })();
    return()=>{cancelled=true;if(mapObj.current&&mapObj.current.remove)try{mapObj.current.remove();}catch{}};
    function placeMarkers(g,map,c){
      // This entry — highlighted, pulsing
      const color=SEV_COLOR[defect.severity]||"#ff6b00";
      const meSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="${color}" opacity="0.3"><animate attributeName="r" values="14;18;14" dur="1.8s" repeatCount="indefinite"/></circle><circle cx="20" cy="20" r="13" fill="rgba(0,0,0,0.55)" stroke="${color}" stroke-width="3.5"/><circle cx="20" cy="20" r="5" fill="${color}"/><text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${defect.severity?defect.severity[0]:""}</text></svg>`;
      new g.Marker({position:c,map,icon:{url:"data:image/svg+xml;utf8,"+encodeURIComponent(meSvg),scaledSize:new g.Size(40,40),anchor:new g.Point(20,20)},zIndex:9999,title:defect.title||"This entry"});
      // Neighbours
      (allDefects||[]).forEach((d,i)=>{
        if(d.id===defect.id)return;
        const co=parseDefectCoords(d);if(!co)return;
        const col=SEV_COLOR[d.severity]||"#8e8e93";
        const numSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="rgba(0,0,0,0.55)" stroke="${col}" stroke-width="2.5"/><text x="13" y="14" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${i+1}</text></svg>`;
        new g.Marker({position:co,map,icon:{url:"data:image/svg+xml;utf8,"+encodeURIComponent(numSvg),scaledSize:new g.Size(26,26),anchor:new g.Point(13,13)},title:d.title||"Entry"});
      });
    }
    function placeLeafletMarkers(L,map,c){
      const color=SEV_COLOR[defect.severity]||"#ff6b00";
      const meHtml=`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="${color}" opacity="0.3"><animate attributeName="r" values="14;18;14" dur="1.8s" repeatCount="indefinite"/></circle><circle cx="20" cy="20" r="13" fill="rgba(0,0,0,0.55)" stroke="${color}" stroke-width="3.5"/><circle cx="20" cy="20" r="5" fill="${color}"/><text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${defect.severity?defect.severity[0]:""}</text></svg>`;
      L.marker([c.lat,c.lng],{icon:L.divIcon({className:"",html:meHtml,iconSize:[40,40],iconAnchor:[20,20]}),zIndexOffset:9999,title:defect.title||"This entry"}).addTo(map);
      (allDefects||[]).forEach((d,i)=>{
        if(d.id===defect.id)return;
        const co=parseDefectCoords(d);if(!co)return;
        const col=SEV_COLOR[d.severity]||"#8e8e93";
        const numHtml=`<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="rgba(0,0,0,0.55)" stroke="${col}" stroke-width="2.5"/><text x="13" y="14" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${i+1}</text></svg>`;
        L.marker([co.lat,co.lng],{icon:L.divIcon({className:"",html:numHtml,iconSize:[26,26],iconAnchor:[13,13]}),title:d.title||"Entry"}).addTo(map);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[coords?.lat,coords?.lng,defect.id,allDefects?.length]);

  if(!coords)return null;
  const openUrl=`https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
  const copy=()=>{try{navigator.clipboard.writeText(`${coords.lat},${coords.lng}`);}catch{}};
  const nearbyCount=(allDefects||[]).filter(d=>d.id!==defect.id&&parseDefectCoords(d)).length;
  return(
    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.06)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em"}}>🗺 MAP LOCATION{nearbyCount>0?` · ${nearbyCount} nearby`:""}</div>
        <a href={openUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:11,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,color:"#ff6b00",textDecoration:"none"}}>Open in Google Maps →</a>
      </div>
      <div ref={mapRef} style={{width:"100%",height:220,borderRadius:10,border:"1px solid rgba(0,0,0,0.1)",background:"#e5e3dc",overflow:"hidden"}}/>
      {status==="error"&&<div style={{fontSize:11,color:"#ff3b30",marginTop:6}}>Map preview unavailable.</div>}
      <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
        <span onClick={copy} title="Tap to copy" style={{fontFamily:"monospace",fontSize:11,color:"rgba(0,0,0,0.55)",cursor:"pointer"}}>{coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}</span>
      </div>
    </div>
  );
}

function DefectDetail({defect,onClose,onUpdate,member,company,members=[],allDefects=[]}){
  const[status,setStatus]=useState(defect.status);
  const[comment,setComment]=useState("");const[saving,setSaving]=useState(false);const[deleting,setDeleting]=useState(false);
  const[commentPhoto,setCommentPhoto]=useState(null);const[verifyPhoto,setVerifyPhoto]=useState(null);
  const commentPhotoRef=useRef();const verifyPhotoRef=useRef();
  const latestRef=useRef(defect);
  useEffect(()=>{latestRef.current={...latestRef.current,...defect,status};},[defect,status]);
  const tgCfg=local.get(TG_KEY);
  const canUpdate=["Admin","Manager","Inspector"].includes(member?.role);
  const canDelete=member?.role==="Admin";
  // Inline edit state
  const[editing,setEditing]=useState(false);
  const[editFields,setEditFields]=useState({
    title:defect.title||"",description:defect.description||"",severity:defect.severity||"Major",
    location:defect.location||"",assignee:defect.assignee||"",component:defect.component||"",
    issue:defect.issue||"",trade:defect.trade||"",entryType:defect.entryType||"Defect",
    workCategory:defect.workCategory||"Building Defects (Landed)",
    locationLevel:defect.locationLevel||"",locationZone:defect.locationZone||"",
    locationSubzone:defect.locationSubzone||"",locationGrid:defect.locationGrid||"",
    dueDate:defect.dueDate||"",duration:defect.duration||"",
    costImpact:defect.costImpact||"",costResponsible:defect.costResponsible||"",
    costAmount:defect.costAmount||"",costRemarks:defect.costRemarks||""
  });
  const[editSaving,setEditSaving]=useState(false);
  const ef=(k,v)=>setEditFields(prev=>({...prev,[k]:v}));
  // Active component groups for edit form (filtered by work category)
  const editComponentGroups=useMemo(()=>{
    const cat=WORK_CATEGORIES[editFields.workCategory];
    if(!cat)return COMPONENT_GROUPS;
    const out={};
    cat.groups.forEach(g=>{if(COMPONENT_GROUPS[g])out[g]=COMPONENT_GROUPS[g];});
    return out;
  },[editFields.workCategory]);
  const editAssignees=members.length>0?members.map(m=>m.name):["Site Manager","Engineer","Contractor","QC Inspector","Safety Officer"];
  const saveEdits=async()=>{
    setEditSaving(true);
    try{
      // Build composite location from sub-fields
      const locParts=[editFields.locationLevel,editFields.locationZone,editFields.locationSubzone,editFields.locationGrid].filter(Boolean);
      const location=locParts.length?locParts.join(" > "):(editFields.location||"");
      const patch={...editFields,location,trade:COMPONENT_TRADE[editFields.component]||editFields.trade||""};
      await DB.defects.update(defect.id,patch);
      const updated={...latestRef.current,...patch};
      latestRef.current=updated;
      onUpdate(updated);
      setEditing(false);
    }catch(e){alert("Save failed: "+e.message);}
    setEditSaving(false);
  };
  // Comment editing state
  const[editingCommentIdx,setEditingCommentIdx]=useState(null);
  const[editingCommentText,setEditingCommentText]=useState("");
  // Comment photo markup state
  const[markupCommentIdx,setMarkupCommentIdx]=useState(null);
  // Before/After photo markup state
  const[markupBA,setMarkupBA]=useState(null); // "before" | "after" | null
  // Full-screen photo viewer state
  const[viewerPhoto,setViewerPhoto]=useState(null);
  // Pending verify status (stored when user picks photo before confirming)
  const[pendingVerifyStatus,setPendingVerifyStatus]=useState(null);

  // Capture photo for comment
  const handleCommentPhoto=e=>{
    const file=e.target.files?.[0];if(!file)return;
    const r=new FileReader();r.onload=()=>setCommentPhoto(r.result);r.readAsDataURL(file);
    if(commentPhotoRef.current)commentPhotoRef.current.value="";
  };

  // Capture verification photo
  const handleVerifyPhoto=e=>{
    const file=e.target.files?.[0];if(!file)return;
    const r=new FileReader();r.onload=()=>setVerifyPhoto(r.result);r.readAsDataURL(file);
    if(verifyPhotoRef.current)verifyPhotoRef.current.value="";
  };

  const updateStatus=async s=>{
    if(!canUpdate)return;
    // Require verification photo for Closed/Verified
    if((s==="Closed"||s==="Verified")&&!verifyPhoto){
      if(confirm(`Add a verification photo to confirm ${s.toLowerCase()}? Tap OK to attach, or Cancel to skip.`)){
        setPendingVerifyStatus(s);
        verifyPhotoRef.current?.click();
        return;
      }
    }
    setPendingVerifyStatus(null);
    setStatus(s);
    try{
      const updateData={status:s};
      if(s==="Closed"||s==="Verified"){
        updateData[s==="Closed"?"closedAt":"verifiedAt"]=new Date().toISOString();
        if(s==="Verified")updateData.verifiedBy=member?.name||"";
        // Add verification photo as comment
        if(verifyPhoto){
          const compressed=await compressPhoto(verifyPhoto,1200,0.8);
          const vComment={text:`✅ ${s} — verification photo attached`,by:member?.name||"",role:member?.role||"",at:Date.now(),photo:compressed||verifyPhoto};
          const newComments=[...(latestRef.current.comments||[]),vComment];
          updateData.comments=newComments;
        }
      }
      await DB.defects.update(defect.id,updateData);
      latestRef.current={...latestRef.current,...updateData};
      onUpdate({...latestRef.current});
      setVerifyPhoto(null);
      if(tgCfg?.token&&tgCfg?.chatId){
        const e=STATUS_ICON[s]||"⚪";
        sendTelegram(tgCfg.token,tgCfg.chatId,`${e} <b>Status Updated</b>\n<b>${sanitize(defect.title)}</b>\nStatus: <b>${s}</b>\nBy: ${sanitize(member?.name)}`).catch(()=>{});
      }
    }catch(e){setStatus(defect.status);alert("Failed to update status: "+e.message);}
  };

  const addComment=async()=>{
    if((!comment.trim()&&!commentPhoto)||saving||!canUpdate)return;
    setSaving(true);
    let photo=null;
    if(commentPhoto){photo=await compressPhoto(commentPhoto,1200,0.8)||commentPhoto;}
    const newComment={text:comment,by:member?.name||"",role:member?.role||"",at:Date.now(),photo};
    const newComments=[...(latestRef.current.comments||[]),newComment];
    try{
      await DB.defects.update(defect.id,{comments:newComments});
      latestRef.current={...latestRef.current,comments:newComments};
      onUpdate({...latestRef.current});
      if(tgCfg?.token&&tgCfg?.chatId)sendTelegram(tgCfg.token,tgCfg.chatId,`💬 <b>Comment — ${sanitize(defect.title)}</b>\n${sanitize(member?.name)}: ${sanitize(comment)}${photo?" [📷 photo]":""}`).catch(()=>{});
      setComment("");setCommentPhoto(null);
    }catch(e){alert("Failed to add comment: "+e.message);}
    setSaving(false);
  };

  // Edit an existing comment
  const saveCommentEdit=async(idx)=>{
    if(!editingCommentText.trim())return;
    const comments=[...(latestRef.current.comments||[])];
    comments[idx]={...comments[idx],text:editingCommentText,editedAt:Date.now()};
    try{
      await DB.defects.update(defect.id,{comments});
      latestRef.current={...latestRef.current,comments};
      onUpdate({...latestRef.current});
    }catch(e){alert("Failed to edit comment: "+e.message);}
    setEditingCommentIdx(null);setEditingCommentText("");
  };

  // Save markup on a comment photo
  const saveCommentMarkup=async(dataUrl)=>{
    if(markupCommentIdx===null)return;
    const comments=[...(latestRef.current.comments||[])];
    comments[markupCommentIdx]={...comments[markupCommentIdx],photo:dataUrl,editedAt:Date.now()};
    try{
      await DB.defects.update(defect.id,{comments});
      latestRef.current={...latestRef.current,comments};
      onUpdate({...latestRef.current});
    }catch(e){alert("Failed to save markup: "+e.message);}
    setMarkupCommentIdx(null);
  };

  // Save markup on before/after photos
  const saveBAMarkup=async(dataUrl)=>{
    if(!markupBA)return;
    try{
      if(markupBA==="before"){
        // Update the original photo
        const photos=Array.isArray(latestRef.current.photo)?[...latestRef.current.photo]:[latestRef.current.photo];
        photos[0]=dataUrl;
        await DB.defects.update(defect.id,{photo:photos.length===1?photos[0]:photos});
        latestRef.current={...latestRef.current,photo:photos.length===1?photos[0]:photos};
      }else{
        // Update the verification comment photo (after)
        const comments=[...(latestRef.current.comments||[])];
        const idx=comments.findIndex(c=>c.text?.startsWith("✅")&&c.photo);
        if(idx>=0){comments[idx]={...comments[idx],photo:dataUrl,editedAt:Date.now()};
          await DB.defects.update(defect.id,{comments});
          latestRef.current={...latestRef.current,comments};
        }
      }
      onUpdate({...latestRef.current});
    }catch(e){alert("Failed to save markup: "+e.message);}
    setMarkupBA(null);
  };

  const deleteDefect=async()=>{
    if(!canDelete||!confirm("Delete this defect permanently? This cannot be undone."))return;
    setDeleting(true);
    try{
      await DB.defects.delete(defect.id);
      onClose();
    }catch(e){alert("Failed to delete: "+e.message);setDeleting(false);}
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:100,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <div style={{position:"sticky",top:0,background:"rgba(240,237,232,0.95)",backdropFilter:"blur(8px)",padding:"16px 16px 12px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid rgba(0,0,0,0.08)",zIndex:10}}>
        <button onClick={onClose} style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:20,padding:"7px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#1a1a1a",flex:1}}>ENTRY DETAIL</div>
        {canUpdate&&!editing&&<button onClick={()=>{setEditFields({title:defect.title||"",description:defect.description||"",severity:defect.severity||"Major",location:defect.location||"",assignee:defect.assignee||"",component:defect.component||"",issue:defect.issue||"",trade:defect.trade||"",entryType:defect.entryType||"Defect",workCategory:defect.workCategory||"Building Defects (Landed)",locationLevel:defect.locationLevel||"",locationZone:defect.locationZone||"",locationSubzone:defect.locationSubzone||"",locationGrid:defect.locationGrid||"",dueDate:defect.dueDate||"",duration:defect.duration||"",costImpact:defect.costImpact||"",costResponsible:defect.costResponsible||"",costAmount:defect.costAmount||"",costRemarks:defect.costRemarks||""});setEditing(true);}} style={{background:"rgba(255,107,0,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.edit")}</button>}
        {canDelete&&<button onClick={deleteDefect} disabled={deleting} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{deleting?"...":t("actions.delete")}</button>}
      </div>
      <div style={{padding:16}}>
        {editing?(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,borderLeft:"5px solid #ff6b00"}}>
            <div style={{fontSize:10,fontWeight:800,color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em",marginBottom:10}}>EDITING ENTRY</div>

            {/* Title */}
            <VoiceField label={t("fields.title")} value={editFields.title} onChange={v=>ef("title",v)} placeholder={t("fields.title_placeholder")}/>

            {/* Description */}
            <VoiceField label={t("fields.what_happened")} value={editFields.description} onChange={v=>ef("description",v)} placeholder={t("fields.description_placeholder")} multiline/>

            {/* Severity */}
            <ComboField label={t("fields.severity")} value={editFields.severity} onChange={v=>ef("severity",v)} options={SEVERITY} placeholder={t("fields.severity_placeholder")} displayFn={sevDisplayFn}/>

            {/* Work Category */}
            <ComboField label={t("fields.work_category")} value={editFields.workCategory} onChange={v=>{ef("workCategory",v);ef("component","");ef("issue","");}} options={Object.keys(WORK_CATEGORIES)} placeholder={t("fields.work_category_placeholder")} displayFn={workcatDisplayFn}/>

            {/* Entry Type */}
            <ComboField label={t("fields.entry_type")} value={editFields.entryType} onChange={v=>ef("entryType",v)} options={getAllEntryTypes()} placeholder={t("fields.entry_type_placeholder")}/>

            {/* Item / Part */}
            <ComboField label={t("fields.item_part")} value={editFields.component} onChange={v=>{ef("component",v);ef("issue","");}} grouped={editComponentGroups} placeholder={t("fields.item_part_placeholder")} displayFn={tOpt}/>

            {/* Issue (filtered by component) */}
            {editFields.component&&(
              <ComboField label={t("fields.issue")} value={editFields.issue} onChange={v=>ef("issue",v)} options={COMPONENT_ISSUES[editFields.component]||COMPONENT_ISSUES["General"]} placeholder={t("fields.issue_placeholder")} displayFn={tOpt}/>
            )}

            {/* Location hierarchy */}
            <ComboField label={t("fields.level_floor")} value={editFields.locationLevel} onChange={v=>ef("locationLevel",v)} options={DEFAULT_LEVELS} placeholder={t("fields.level_floor_placeholder")} displayFn={tOpt}/>
            <ComboField label={t("fields.zone")} value={editFields.locationZone} onChange={v=>ef("locationZone",v)} options={DEFAULT_ZONES} placeholder={t("fields.zone_placeholder")} displayFn={tOpt}/>
            <ComboField label={t("fields.room_area")} value={editFields.locationSubzone} onChange={v=>ef("locationSubzone",v)} options={DEFAULT_SUBZONES} placeholder={t("fields.room_area_placeholder")} displayFn={tOpt}/>
            <VoiceField label={t("fields.grid_ref")} value={editFields.locationGrid} onChange={v=>ef("locationGrid",v)} placeholder={t("fields.grid_ref_placeholder")}/>

            {/* Assignee */}
            <ComboField label={t("fields.assign_to")} value={editFields.assignee} onChange={v=>ef("assignee",v)} options={editAssignees} placeholder={t("fields.assign_to_placeholder")}/>

            {/* Cost & Time */}
            <div style={{background:"rgba(0,0,0,0.02)",borderRadius:12,padding:14,marginBottom:16,border:"1px solid rgba(0,0,0,0.06)"}}>
              <div style={{marginBottom:12}}>
                <label style={lbl()}>{t("log.due_date")}</label>
                <input type="date" value={editFields.dueDate} onChange={e=>ef("dueDate",e.target.value)} style={{...inp,width:"100%",flex:"unset"}}/>
              </div>
              <ComboField label={t("fields.time_needed")} value={editFields.duration} onChange={v=>ef("duration",v)} options={DURATION_OPTIONS} placeholder={t("fields.time_needed_placeholder")} displayFn={tOpt}/>
              <ComboField label={t("fields.cost_change")} value={editFields.costImpact} onChange={v=>ef("costImpact",v)} options={COST_IMPACT_OPTIONS} placeholder={t("fields.cost_change_placeholder")} displayFn={tOpt}/>
              {editFields.costImpact&&editFields.costImpact!=="No change"&&editFields.costImpact!=="To be confirmed by QS"&&(
                <>
                  <VoiceField label={t("fields.cost_amount")} value={editFields.costAmount} onChange={v=>ef("costAmount",v)} placeholder={t("fields.cost_amount_placeholder")}/>
                  <ComboField label={t("fields.cost_responsible")} value={editFields.costResponsible} onChange={v=>ef("costResponsible",v)} options={COST_RESPONSIBLE_OPTIONS} placeholder={t("fields.cost_responsible_placeholder")} displayFn={tOpt}/>
                  <VoiceField label={t("fields.cost_remarks")} value={editFields.costRemarks} onChange={v=>ef("costRemarks",v)} placeholder={t("fields.cost_remarks_placeholder")} multiline/>
                </>
              )}
            </div>

            <div style={{display:"flex",gap:8}}>
              <button onClick={saveEdits} disabled={editSaving} style={{flex:1,background:"#ff6b00",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",opacity:editSaving?0.7:1}}>{editSaving?t("messages.saving"):t("actions.save_changes")}</button>
              <button onClick={()=>{setEditing(false);}} style={{background:"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"12px 16px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.cancel")}</button>
            </div>
          </div>
        ):(
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,borderLeft:`5px solid ${SEV_COLOR[defect.severity]}`}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:20,color:"#1a1a1a",marginBottom:10}}>{defect.title}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>{defect.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(defect.entryType),background:typeBg(defect.entryType),padding:"3px 10px",borderRadius:12,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(defect.entryType)} {tOpt(defect.entryType).toUpperCase()}</span>}<SevChip s={defect.severity}/><StatusChip s={status}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {[["📍 "+t("fields.location"),defect.location],["👤 "+t("detail.assigned"),defect.assignee],["📁 "+t("fields.project_name"),defect.projectName||"—"],["🗓 "+t("fields.date"),defect.created?new Date(defect.created).toLocaleDateString():"—"],["✍️ "+t("fields.logged_by"),defect.loggedBy],["🔑 "+t("fields.role"),defect.loggedByRole||"—"]].map(([l,v])=>(
                <div key={l}><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em"}}>{l}</div><div style={{fontSize:13,color:"#1a1a1a",marginTop:2}}>{v||"—"}</div></div>
              ))}
            </div>
            {defect.description&&(
              <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.06)"}}>
                <div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>{t("detail.description")}</div>
                <div style={{fontSize:13,color:"#444",lineHeight:1.5}}>{defect.description}</div>
              </div>
            )}
            <DefectMiniMap defect={defect} allDefects={allDefects}/>
          </div>
        )}

        {defect.photo&&(()=>{
          const origPhoto=typeof defect.photo==="string"?defect.photo:Array.isArray(defect.photo)&&defect.photo[0]?defect.photo[0]:null;
          const verifyComment=(latestRef.current.comments||[]).find(c=>c.text?.startsWith("✅")&&c.photo);
          const afterPhoto=verifyComment?.photo;
          return afterPhoto&&origPhoto?(
            <BeforeAfter before={origPhoto} after={afterPhoto} onMarkup={canUpdate?(which=>setMarkupBA(which)):null}/>
          ):typeof defect.photo==="string"
            ?<img src={defect.photo} alt="" onClick={()=>setViewerPhoto(defect.photo)} style={{maxWidth:"100%",borderRadius:12,maxHeight:350,objectFit:"contain",display:"block",marginBottom:14,background:"#f8f8f6",cursor:"pointer"}} title="Tap to view full screen"/>
            :Array.isArray(defect.photo)&&defect.photo.length>0
              ?<div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:14}}>
                {defect.photo.map((p,i)=><img key={i} src={p} alt="" onClick={()=>setViewerPhoto(p)} style={{height:180,borderRadius:12,objectFit:"cover",flexShrink:0,cursor:"pointer"}} title="Tap to view full screen"/>)}
              </div>
              :null;
        })()}

        {canUpdate&&(
          <div style={{marginBottom:14}}>
            <div style={lbl()}>{t("detail.update_status")}</div>
            <div style={{display:"flex",gap:8}}>
              {STATUS.map(s=>(
                <button key={s} onClick={()=>updateStatus(s)} style={{flex:1,padding:"10px 4px",borderRadius:10,border:`2px solid ${status===s?STATUS_COLOR[s]:"rgba(0,0,0,0.1)"}`,background:status===s?STATUS_COLOR[s]+"20":"#fff",color:status===s?STATUS_COLOR[s]:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{(STATUS_I18N[s]?t(STATUS_I18N[s]):s).toUpperCase()}</button>
              ))}
            </div>
          </div>
        )}

        {/* Verification photo preview + confirm panel */}
        {verifyPhoto&&pendingVerifyStatus&&(
          <div style={{background:"rgba(48,209,88,0.06)",border:"1.5px solid rgba(48,209,88,0.25)",borderRadius:14,padding:14,marginBottom:14}}>
            <div style={lbl("#30d158")}>VERIFICATION PHOTO — {pendingVerifyStatus.toUpperCase()}</div>
            <div style={{position:"relative",marginBottom:10}}>
              <img src={verifyPhoto} alt="" onClick={()=>setViewerPhoto(verifyPhoto)} style={{width:"100%",maxHeight:280,objectFit:"contain",borderRadius:10,background:"#f8f8f6",cursor:"pointer"}} title="Tap to view full screen"/>
              <button onClick={()=>{setVerifyPhoto(null);setPendingVerifyStatus(null);}} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:26,height:26,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>updateStatus(pendingVerifyStatus)} style={{flex:1,background:"#30d158",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer"}}>CONFIRM {pendingVerifyStatus.toUpperCase()}</button>
              <button onClick={()=>{verifyPhotoRef.current?.click();}} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"12px 16px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>RETAKE</button>
            </div>
          </div>
        )}

        <div>
          <div style={lbl()}>{t("detail.timeline")} ({(latestRef.current.comments||[]).length})</div>
          {(latestRef.current.comments||[]).map((c,i)=>{
            const isVerify=c.text?.startsWith("✅");
            const isStatus=c.text?.startsWith("✅")||c.text?.startsWith("🔄");
            const timelineColor=isVerify?"#34c759":isStatus?"#5856d6":"#ff6b00";
            const REACTIONS=["👍","✅","⚠️","🔧"];
            const reactions=c.reactions||{};
            const addReaction=async(emoji)=>{
              const comments=[...(latestRef.current.comments||[])];
              const entry=comments[i];
              if(!entry.reactions)entry.reactions={};
              const key=emoji;
              if(!entry.reactions[key])entry.reactions[key]=[];
              const name=member?.name||"";
              if(entry.reactions[key].includes(name)){entry.reactions[key]=entry.reactions[key].filter(n=>n!==name);}
              else{entry.reactions[key].push(name);}
              if(entry.reactions[key].length===0)delete entry.reactions[key];
              try{
                await DB.defects.update(defect.id,{comments});
                latestRef.current={...latestRef.current,comments};
                onUpdate({...latestRef.current});
              }catch{}
            };
            return(
              <div key={i} style={{display:"flex",gap:10,marginBottom:0,position:"relative"}}>
                {/* Timeline line */}
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,width:20}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:timelineColor,border:"2px solid #f0ede8",zIndex:1,flexShrink:0}}/>
                  {i<(latestRef.current.comments||[]).length-1&&<div style={{width:2,flex:1,background:"rgba(0,0,0,0.08)"}}/>}
                </div>
                {/* Content */}
                <div style={{flex:1,background:"#fff",borderRadius:10,padding:"10px 12px",marginBottom:10,borderLeft:`3px solid ${timelineColor}`}}>
                  <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:3}}>
                    <span style={{fontSize:11,fontWeight:700,color:timelineColor,fontFamily:"'Barlow Condensed',sans-serif"}}>{c.by}</span>
                    {c.role&&<RoleChip r={c.role}/>}
                    <span style={{fontSize:10,color:"rgba(0,0,0,0.3)"}}>{new Date(c.at).toLocaleDateString()}{" "}{new Date(c.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                  {editingCommentIdx===i?(
                    <div style={{display:"flex",gap:6,alignItems:"center",marginTop:4}}>
                      <input autoFocus value={editingCommentText} onChange={e=>setEditingCommentText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveCommentEdit(i)} style={{...inp,flex:1,fontSize:13}}/>
                      <button onClick={()=>saveCommentEdit(i)} style={{background:"#ff6b00",border:"none",borderRadius:8,padding:"6px 12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.save")}</button>
                      <button onClick={()=>{setEditingCommentIdx(null);setEditingCommentText("");}} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"6px 10px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer",color:"rgba(0,0,0,0.5)"}}>{t("actions.cancel")}</button>
                    </div>
                  ):(
                    <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
                      {c.text&&<div style={{fontSize:13,color:"#333",flex:1}}>{c.text}{c.editedAt&&<span style={{fontSize:9,color:"rgba(0,0,0,0.25)",marginLeft:6}}>(edited)</span>}</div>}
                      {canUpdate&&c.by===(member?.name||"")&&c.text&&!isStatus&&<button onClick={()=>{setEditingCommentIdx(i);setEditingCommentText(c.text);}} title="Edit comment" style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"rgba(0,0,0,0.25)",padding:2,flexShrink:0}}>✏️</button>}
                    </div>
                  )}
                  {c.photo&&(
                    <div style={{position:"relative",marginTop:6}}>
                      <img src={c.photo} alt="" onClick={()=>setViewerPhoto(c.photo)} style={{width:"100%",maxHeight:280,objectFit:"contain",borderRadius:8,background:"#f8f8f6",cursor:"pointer"}} title="Tap to view full screen"/>
                      <div style={{position:"absolute",bottom:6,right:6,display:"flex",gap:4}}>
                        <button onClick={()=>setViewerPhoto(c.photo)} style={{background:"rgba(0,0,0,0.6)",border:"none",borderRadius:6,padding:"3px 8px",fontSize:10,color:"#fff",fontWeight:700,cursor:"pointer"}}>🔍 VIEW</button>
                        {canUpdate&&<button onClick={()=>setMarkupCommentIdx(i)} style={{background:"rgba(0,0,0,0.6)",border:"none",borderRadius:6,padding:"3px 8px",fontSize:10,color:"#fff",fontWeight:700,cursor:"pointer"}}>✏ MARKUP</button>}
                      </div>
                    </div>
                  )}
                  {/* Reactions */}
                  <div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap",alignItems:"center"}}>
                    {Object.entries(reactions).map(([emoji,users])=>(
                      <button key={emoji} onClick={()=>addReaction(emoji)} style={{background:users.includes(member?.name||"")?"rgba(255,107,0,0.12)":"rgba(0,0,0,0.04)",border:users.includes(member?.name||"")?"1px solid rgba(255,107,0,0.3)":"1px solid rgba(0,0,0,0.08)",borderRadius:12,padding:"2px 8px",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:3}} title={users.join(", ")}>{emoji}<span style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.5)"}}>{users.length}</span></button>
                    ))}
                    {canUpdate&&<div style={{display:"flex",gap:2,marginLeft:Object.keys(reactions).length?4:0}}>
                      {REACTIONS.filter(r=>!reactions[r]).map(emoji=>(
                        <button key={emoji} onClick={()=>addReaction(emoji)} style={{background:"none",border:"none",fontSize:13,cursor:"pointer",opacity:0.3,padding:2}} title={`React with ${emoji}`}>{emoji}</button>
                      ))}
                    </div>}
                  </div>
                </div>
              </div>
            );
          })}
          {canUpdate?(
            <div>
              <input type="file" accept="image/*" capture="environment" ref={commentPhotoRef} onChange={handleCommentPhoto} style={{display:"none"}}/>
              <input type="file" accept="image/*" capture="environment" ref={verifyPhotoRef} onChange={handleVerifyPhoto} style={{display:"none"}}/>
              {commentPhoto&&(
                <div style={{position:"relative",marginBottom:8,display:"inline-block"}}>
                  <img src={commentPhoto} alt="" style={{height:80,borderRadius:8,objectFit:"cover"}}/>
                  <button onClick={()=>setCommentPhoto(null)} style={{position:"absolute",top:2,right:2,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:20,height:20,fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                </div>
              )}
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <button onClick={()=>commentPhotoRef.current?.click()} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:16,flexShrink:0}}>📷</button>
                <input value={comment} onChange={e=>setComment(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addComment()} placeholder={t("fields.comment_placeholder")} style={{...inp,flex:1}}/>
                <MicBtn onResult={t=>setComment(c=>c+(c?" ":"")+t)} append currentValue={comment}/>
                <button onClick={addComment} disabled={saving||(!comment.trim()&&!commentPhoto)} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"11px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>{saving?"...":"POST"}</button>
              </div>
            </div>
          ):(
            <div style={{background:"rgba(0,0,0,0.04)",borderRadius:10,padding:"12px",textAlign:"center",fontSize:12,color:"rgba(0,0,0,0.4)"}}>Viewer access — comments disabled</div>
          )}
        </div>
      </div>
      {/* Comment photo markup modal */}
      {markupCommentIdx!==null&&(latestRef.current.comments||[])[markupCommentIdx]?.photo&&(
        <PhotoMarkup src={(latestRef.current.comments||[])[markupCommentIdx].photo} onSave={saveCommentMarkup} onCancel={()=>setMarkupCommentIdx(null)}/>
      )}
      {/* Before/After photo markup modal */}
      {markupBA&&(()=>{
        const origPhoto=typeof latestRef.current.photo==="string"?latestRef.current.photo:Array.isArray(latestRef.current.photo)&&latestRef.current.photo[0]?latestRef.current.photo[0]:null;
        const verifyComment=(latestRef.current.comments||[]).find(c=>c.text?.startsWith("✅")&&c.photo);
        const src=markupBA==="before"?origPhoto:verifyComment?.photo;
        return src?<PhotoMarkup src={src} onSave={saveBAMarkup} onCancel={()=>setMarkupBA(null)}/>:null;
      })()}
      {/* Full-screen photo viewer modal */}
      {viewerPhoto&&<PhotoViewer src={viewerPhoto} onClose={()=>setViewerPhoto(null)}/>}
    </div>
  );
}

// ── Report ────────────────────────────────────────────────────────
// ── Profile Panel (edit name, email, password) ──────────────────
function ProfilePanel({member,authUser,company,onClose,onSignOut,onCompanyUpdate}){
  const[editName,setEditName]=useState(member?.name||"");
  const[editEmail,setEditEmail]=useState(member?.email||authUser?.email||"");
  const[editJobTitle,setEditJobTitle]=useState(member?.jobTitle||"");
  const[editCompanyName,setEditCompanyName]=useState(company?.companyName||"");
  const[oldPass,setOldPass]=useState("");const[newPass,setNewPass]=useState("");const[confirmPass,setConfirmPass]=useState("");
  const[saving,setSaving]=useState(false);const[msg,setMsg]=useState(null);
  const[showDeleteConfirm,setShowDeleteConfirm]=useState(false);const[deleting,setDeleting]=useState(false);
  const isCompanyAdmin=member?.role==="Admin";

  const deleteAccount=async()=>{
    setDeleting(true);setMsg(null);
    try{
      // Delete member record
      if(member?.id)await DB.members.delete(member.id);
      // Delete user account via PocketBase API
      const pbUrl=localStorage.getItem('pb_url')||'https://api.siteshrimp.org';
      const token=JSON.parse(localStorage.getItem('pb_auth')||'{}').token;
      if(authUser?.id&&token){
        await fetch(`${pbUrl}/api/collections/users/records/${authUser.id}`,{method:'DELETE',headers:{'Authorization':`Bearer ${token}`}});
      }
      // Clear local data
      localStorage.clear();
      if(window.indexedDB)try{indexedDB.deleteDatabase('siteshrimp');}catch(e){}
      window.location.reload();
    }catch(e){setMsg({type:"err",text:"Delete failed: "+e.message});setDeleting(false);}
  };

  const saveProfile=async()=>{
    if(!editName.trim())return;
    const changes={};
    if(editName.trim()!==member?.name)changes.name=editName.trim();
    if(editJobTitle.trim()!==member?.jobTitle)changes.jobTitle=editJobTitle.trim();
    if(Object.keys(changes).length===0)return;
    setSaving(true);setMsg(null);
    try{
      await DB.members.update(member.id,changes);
      setMsg({type:"ok",text:"Profile updated"});
    }catch(e){setMsg({type:"err",text:e.message});}
    setSaving(false);
  };

  const saveCompanyName=async()=>{
    const trimmed=editCompanyName.trim();
    if(!trimmed||trimmed===company?.companyName)return;
    setSaving(true);setMsg(null);
    try{
      await DB.companies.update(company.companyId,{name:trimmed});
      // Propagate the new name into the App's `company` state so every
      // reference (top bar, exports, email subject, etc.) reflects the
      // change without a reload. Previously only the DB was updated and
      // the UI still showed the old name, which looked like a silent failure.
      if(onCompanyUpdate)onCompanyUpdate(trimmed);
      setMsg({type:"ok",text:"Company name updated"});
    }catch(e){
      // Surface the real backend error — typically a PocketBase API rule
      // mismatch or auth-token issue. Plain "Failed" isn't actionable.
      const raw=e?.message||String(e);
      setMsg({type:"err",text:`Save failed: ${raw}`});
      console.warn("saveCompanyName error",e);
    }
    setSaving(false);
  };

  const saveEmail=async()=>{
    if(!editEmail.trim()||editEmail===authUser?.email)return;
    setSaving(true);setMsg(null);
    try{
      // Update auth user email via PocketBase
      const token=JSON.parse(localStorage.getItem("pb_auth")||"{}").token||"";
      const resp=await fetch(DB.baseUrl+"/api/collections/users/records/"+authUser.id,{
        method:"PATCH",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
        body:JSON.stringify({email:editEmail.trim()})
      });
      if(!resp.ok){const d=await resp.json();throw new Error(d?.message||"Failed");}
      // Update member record too
      if(member?.id)await DB.members.update(member.id,{email:editEmail.trim()});
      setMsg({type:"ok",text:"Email updated"});
    }catch(e){setMsg({type:"err",text:e.message});}
    setSaving(false);
  };

  const savePassword=async()=>{
    if(!oldPass||!newPass){setMsg({type:"err",text:"Fill in both fields"});return;}
    if(newPass!==confirmPass){setMsg({type:"err",text:"Passwords don't match"});return;}
    if(newPass.length<8){setMsg({type:"err",text:"Password must be at least 8 characters"});return;}
    setSaving(true);setMsg(null);
    try{
      const token=JSON.parse(localStorage.getItem("pb_auth")||"{}").token||"";
      const resp=await fetch(DB.baseUrl+"/api/collections/users/records/"+authUser.id,{
        method:"PATCH",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
        body:JSON.stringify({oldPassword:oldPass,password:newPass,passwordConfirm:newPass})
      });
      if(!resp.ok){const d=await resp.json();throw new Error(d?.data?.oldPassword?.message||d?.message||"Failed");}
      setOldPass("");setNewPass("");setConfirmPass("");
      setMsg({type:"ok",text:"Password changed successfully"});
    }catch(e){setMsg({type:"err",text:e.message});}
    setSaving(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:300,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("profile.title")}/>
      <div style={{padding:20}}>
        {/* Avatar */}
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:24}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:800,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>{(member?.name||"?")[0].toUpperCase()}</div>
          <div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"#1a1a1a"}}>{member?.name}</div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}><RoleChip r={member?.role}/><span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>{member?.jobTitle}</span></div>
          </div>
        </div>

        {msg&&<div style={{background:msg.type==="ok"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${msg.type==="ok"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:msg.type==="ok"?"#30d158":"#ff3b30",fontWeight:700}}>{msg.text}</div>}

        {/* Edit Name + Job Title */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:12}}>
          <div style={lbl()}>DISPLAY NAME</div>
          <input value={editName} onChange={e=>setEditName(e.target.value)} style={{...inp,width:"100%",marginBottom:10}}/>
          <div style={lbl()}>JOB TITLE</div>
          <input value={editJobTitle} onChange={e=>setEditJobTitle(e.target.value)} placeholder="e.g. Site Engineer, Project Manager" style={{...inp,width:"100%",marginBottom:10}}/>
          <button onClick={saveProfile} disabled={saving||(editName===member?.name&&editJobTitle===(member?.jobTitle||""))} style={{width:"100%",background:(editName!==member?.name||editJobTitle!==(member?.jobTitle||""))?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"12px",color:(editName!==member?.name||editJobTitle!==(member?.jobTitle||""))?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>SAVE PROFILE</button>
        </div>

        {/* Edit Email */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:12}}>
          <div style={lbl()}>EMAIL</div>
          <div style={{display:"flex",gap:8}}>
            <input value={editEmail} onChange={e=>setEditEmail(e.target.value)} type="email" style={{...inp,flex:1}}/>
            <button onClick={saveEmail} disabled={saving||!editEmail.trim()||editEmail===authUser?.email} style={{background:editEmail!==authUser?.email?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"10px 16px",color:editEmail!==authUser?.email?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0}}>{t("actions.save")}</button>
          </div>
        </div>

        {/* Company Name (Admin only — affects every member) */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:12}}>
          <div style={{...lbl(),display:"flex",alignItems:"center",gap:8}}>COMPANY NAME {!isCompanyAdmin&&<span style={{fontSize:9,fontWeight:700,color:"rgba(0,0,0,0.35)",letterSpacing:"0.12em"}}>· ADMIN ONLY</span>}</div>
          <div style={{display:"flex",gap:8}}>
            <input value={editCompanyName} onChange={e=>setEditCompanyName(e.target.value)} disabled={!isCompanyAdmin} placeholder={t("auth.company_placeholder")} style={{...inp,flex:1,opacity:isCompanyAdmin?1:0.6}}/>
            <button onClick={saveCompanyName} disabled={saving||!isCompanyAdmin||!editCompanyName.trim()||editCompanyName.trim()===company?.companyName} style={{background:(isCompanyAdmin&&editCompanyName.trim()&&editCompanyName.trim()!==company?.companyName)?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"10px 16px",color:(isCompanyAdmin&&editCompanyName.trim()&&editCompanyName.trim()!==company?.companyName)?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:isCompanyAdmin?"pointer":"not-allowed",flexShrink:0}}>{t("actions.save")}</button>
          </div>
          {!isCompanyAdmin&&<div style={{fontSize:10,color:"rgba(0,0,0,0.35)",marginTop:6,lineHeight:1.4}}>Only a company admin can change this. Ask your admin to update it.</div>}
        </div>

        {/* Change Password */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:12}}>
          <div style={lbl()}>CHANGE PASSWORD</div>
          <input value={oldPass} onChange={e=>setOldPass(e.target.value)} type="password" placeholder="Current password" style={{...inp,width:"100%",marginBottom:8}}/>
          <input value={newPass} onChange={e=>setNewPass(e.target.value)} type="password" placeholder="New password (min 8 chars)" style={{...inp,width:"100%",marginBottom:8}}/>
          <input value={confirmPass} onChange={e=>setConfirmPass(e.target.value)} type="password" placeholder="Confirm new password" style={{...inp,width:"100%",marginBottom:10}}/>
          <button onClick={savePassword} disabled={saving||!oldPass||!newPass} style={{width:"100%",background:oldPass&&newPass?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"12px",color:oldPass&&newPass?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>UPDATE PASSWORD</button>
        </div>

        {/* Email report settings are managed under the Report tab */}
        <button onClick={onSignOut} style={{width:"100%",background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.15)",borderRadius:14,padding:"14px 16px",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#ff3b30",marginBottom:8}}>Sign Out</button>

        {!showDeleteConfirm?(
          <button onClick={()=>setShowDeleteConfirm(true)} style={{width:"100%",background:"none",border:"none",padding:"12px 16px",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:"rgba(255,59,48,0.5)"}}>Delete Account</button>
        ):(
          <div style={{background:"rgba(255,59,48,0.06)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:14,padding:16}}>
            <div style={{fontSize:13,color:"#ff3b30",fontWeight:700,marginBottom:8,fontFamily:"'Barlow Condensed',sans-serif"}}>DELETE ACCOUNT</div>
            <div style={{fontSize:12,color:"rgba(255,59,48,0.7)",marginBottom:12,lineHeight:1.5}}>This will permanently delete your account, all your entries, photos, and data. This action cannot be undone.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setShowDeleteConfirm(false)} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"11px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",color:"#666"}}>CANCEL</button>
              <button onClick={deleteAccount} disabled={deleting} style={{flex:1,background:"#ff3b30",border:"none",borderRadius:10,padding:"11px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",color:"#fff"}}>{deleting?"DELETING...":"YES, DELETE"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Report({defects,onEmailSetup,currentProject,company}){
  const[sending,setSending]=useState(false);const[sendRes,setSendRes]=useState(null);
  const[showFilters,setShowFilters]=useState(false);const[showExportMenu,setShowExportMenu]=useState(false);const[showEmailMenu,setShowEmailMenu]=useState(false);
  const[showContractAdvisor,setShowContractAdvisor]=useState(false);
  const[contractBusy,setContractBusy]=useState(false);
  const[contractProgress,setContractProgress]=useState([]);
  const[contractSummary,setContractSummary]=useState("");
  const[contractError,setContractError]=useState("");
  const[contractTokens,setContractTokens]=useState(null);
  const[sevFilter,setSevFilter]=useState([]);const[statusFilter,setStatusFilter]=useState([]);
  const[assigneeFilter,setAssigneeFilter]=useState([]);const[dateFrom,setDateFrom]=useState("");const[dateTo,setDateTo]=useState("");
  const[showPreview,setShowPreview]=useState(false);
  const[pdfExport,setPdfExport]=useState({active:false,label:""});
  // Section toggles for email content
  const[incDefects,setIncDefects]=useState(true);
  const[incDrawings,setIncDrawings]=useState(true);
  const[incComparisons,setIncComparisons]=useState(true);
  const[incMap,setIncMap]=useState(true);
  // Load drawings list from DB for preview
  const[reportDrawings,setReportDrawings]=useState([]);
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    DB.drawings.list(`companyId="${company.companyId}" && projectId="${currentProject.id}"`).then(items=>setReportDrawings(items)).catch(()=>{});
  },[company?.companyId,currentProject?.id]);
  const[reportPins,setReportPins]=useState([]);
  useEffect(()=>{
    if(!reportDrawings.length)return;
    Promise.all(reportDrawings.map(d=>DB.pins.list(`drawingId="${d.id}"`))).then(results=>{
      const flat=results.flat();
      console.log("[Report] Loaded pins:",flat.length,"for",reportDrawings.length,"drawings",flat);
      setReportPins(flat);
    }).catch(e=>console.warn("[Report] Pin load failed:",e));
  },[reportDrawings]);
  const savedComparisons=getSavedComparisons(currentProject?.id);
  const drawingsWithAnnotations=reportDrawings.filter(d=>getDrawingMarkup(d.id).length>0||getDrawingNotes(d.id).length>0||reportPins.some(p=>p.drawingId===d.id));
  const totalMarkups=reportDrawings.reduce((s,d)=>s+getDrawingMarkup(d.id).length,0);
  const totalNotes=reportDrawings.reduce((s,d)=>s+getDrawingNotes(d.id).length,0);
  const totalPins=reportPins.length;
  const totalAnnotations=totalMarkups+totalNotes+totalPins;

  const emailCfg=local.get(EMAIL_KEY);
  const emailReady=!!(emailCfg?.recipients?.length);
  const toggleArr=(arr,setArr,val)=>setArr(a=>a.includes(val)?a.filter(x=>x!==val):[...a,val]);
  const clearFilters=()=>{setSevFilter([]);setStatusFilter([]);setAssigneeFilter([]);setDateFrom("");setDateTo("");};
  const activeFilters=sevFilter.length+statusFilter.length+assigneeFilter.length+(dateFrom?1:0)+(dateTo?1:0);
  const allAssignees=[...new Set(defects.map(d=>d.assignee).filter(Boolean))];

  const filtered=defects.filter(d=>{
    if(sevFilter.length&&!sevFilter.includes(d.severity))return false;
    if(statusFilter.length&&!statusFilter.includes(d.status))return false;
    if(assigneeFilter.length&&!assigneeFilter.includes(d.assignee))return false;
    if(dateFrom||dateTo){
      const dt=d.created?new Date(d.created):null;
      if(dt){
        if(dateFrom&&dt<new Date(dateFrom))return false;
        if(dateTo&&dt>new Date(dateTo+"T23:59:59"))return false;
      }
    }
    return true;
  });

  const buildEmailOpts=()=>({
    drawingsHtml:incDrawings?generateDrawingsEmailHTML(reportDrawings,reportPins,defects):"",
    comparisonsHtml:incComparisons?generateComparisonsEmailHTML(savedComparisons):""
  });

  const sendReport=async()=>{
    if(!emailReady)return;
    setSending(true);setSendRes(null);
    try{
      const opts=buildEmailOpts();
      const html=generateEmailHTML(incDefects?filtered:[],currentProject?.name,company?.companyName,opts);
      const timestamp=new Date().toLocaleString("en-GB",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
      const totalItems=filtered.length;
      const subject=`${currentProject?.name||"Project"} – ${timestamp} – ${totalItems} Site Item${totalItems!==1?"s":""} Checked`;
      await DB.sendEmail(emailCfg.recipients.filter(r=>r.trim()),subject,html);
      setSendRes("success");
    }catch(e){console.error(e);setSendRes("fail");}
    setSending(false);setTimeout(()=>setSendRes(null),4000);
  };

  const total=filtered.length;
  const bySev=SEVERITY.map(s=>({s,count:filtered.filter(d=>d.severity===s).length}));
  const byStatus=STATUS.map(s=>({s,count:filtered.filter(d=>d.status===s).length}));
  const byAssignee=allAssignees.map(t=>({t,open:filtered.filter(d=>d.assignee===t&&d.status==="Open").length,total:filtered.filter(d=>d.assignee===t).length})).filter(x=>x.total>0);

  const runContractAdvisor=async()=>{
    if(!isAiConfigured()){
      setContractError("AI is not configured. Open Settings → AI Setup first.");
      return;
    }
    if(filtered.length===0){
      setContractError("No defects in report. Log defects first, then run Contract Advisor.");
      return;
    }

    setContractBusy(true);
    setContractError("");
    setContractSummary("");
    setContractTokens(null);
    setContractProgress(["⚖️ Starting contract advisor..."]);

    try{
      // Step 1: Auto-detect available contract PDFs and extract text
      setContractProgress(prev=>[...prev,"Step 1/4: Reading contract PDFs..."]);
      const extractedTexts=await extractContractTexts({
        usePssoc:true,useRedas:true,useSia:true,
        onProgress:(msg)=>setContractProgress(prev=>[...prev,"  📄 "+msg])
      });
      const successCount=extractedTexts.filter(e=>!e.text.startsWith("(Failed")).length;
      const totalChars=extractedTexts.reduce((sum,e)=>sum+e.text.length,0);
      setContractProgress(prev=>[...prev,successCount>0
        ?`  ✓ ${successCount} contract(s) read, ~${Math.round(totalChars/1000)}k chars`
        :"  ⚠ No contract PDFs found — AI will use general knowledge"]);

      // Step 2: Compile defects from report
      setContractProgress(prev=>[...prev,`Step 2/4: Compiling ${filtered.length} defect(s) from report...`]);
      const defectsSummary=filtered.slice(0,30).map((d,i)=>
        `${i+1}. [${(d.severity||"—").toUpperCase()}] ${d.title||"Untitled"} — ${d.description||"No description"} (Status: ${d.status||"—"}, Trade: ${d.trade||"—"}, Location: ${d.location||"—"}, Assignee: ${d.assignee||"—"})`
      ).join("\n")+(filtered.length>30?`\n... and ${filtered.length-30} more defects`:"");

      // Step 3: Send to AI
      setContractProgress(prev=>[...prev,"Step 3/4: AI analyzing defects against contract clauses..."]);
      const prompt=buildContractAdvisorPrompt({
        clauseUse:"General compliance",
        contextText:"",
        sourceMode:"existing",
        usePssoc:true,useRedas:true,useSia:true,
        uploadSummaries:"",uploadExtracts:"",
        extractedTexts,defectsSummary
      });
      const result=await askAIWithUsage(prompt);
      if(!result.text)throw new Error("AI returned an empty response. Check AI Setup.");

      // Step 4: Done
      setContractSummary(result.text.trim());
      setContractTokens(result.tokens);
      const t=result.tokens;
      setContractProgress(prev=>[...prev,
        `Step 4/4: ✓ Advisory complete`+(t?` — ${t.provider}: ${t.prompt.toLocaleString()} prompt + ${t.completion.toLocaleString()} completion = ${t.total.toLocaleString()} tokens`:"")]);
    }catch(e){
      setContractError(e?.message||"Failed to generate contract advisory.");
      setContractProgress(prev=>[...prev,"⚠ Workflow ended with an error"]);
    }
    setContractBusy(false);
  };

  const Chip=({label,active,color,onClick})=>(
    <button onClick={onClick} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${active?(color||"#1a1a1a"):"rgba(0,0,0,0.12)"}`,background:active?(color||"#1a1a1a"):"#fff",color:active?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{label}</button>
  );

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a",marginBottom:2}}>{t("report.site_report")}</div>
      <div style={{fontSize:12,color:"rgba(0,0,0,0.4)",marginBottom:10}}>{currentProject?.name||""} · {new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</div>

      <div style={{display:"flex",gap:6,marginBottom:10}}>
        <div style={{position:"relative",flex:1,display:"flex"}}>
          <button onClick={()=>setShowEmailMenu(m=>!m)} disabled={sending} style={{flex:1,background:showEmailMenu?"#ff6b00":"#ff6b00",border:"none",borderRadius:10,padding:"10px 6px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer",opacity:sending?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
            {sending?<><Spin size={12}/><span>...</span></>:<>{emailReady?`📧 ${t("report.email_btn")} ✓ ▾`:`📧 ${t("report.email_btn")} ▾`}</>}
          </button>
          {showEmailMenu&&(
            <div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#fff",borderRadius:12,boxShadow:"0 4px 20px rgba(0,0,0,0.15)",border:"1px solid rgba(0,0,0,0.08)",zIndex:20,minWidth:240,overflow:"hidden"}}>
              <button onClick={()=>{setShowEmailMenu(false);if(emailReady)sendReport();else onEmailSetup();}} disabled={!emailReady} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:emailReady?"pointer":"default",color:emailReady?"#ff6b00":"rgba(0,0,0,0.25)"}}>📧 {emailReady?t("report.send_report"):t("report.send_report_not_configured")}</button>
              <button onClick={()=>{setShowEmailMenu(false);onEmailSetup();}} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",color:"#1a1a1a"}}>⚙️ {t("report.edit_recipients")}</button>
              {emailReady&&<button onClick={()=>{setShowEmailMenu(false);local.del(EMAIL_KEY);}} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",color:"#ff3b30"}}>🗑 {t("report.reset_email")}</button>}
              <div style={{padding:"10px 16px",borderTop:"1px solid rgba(0,0,0,0.04)",background:"#fafafa"}}>
                <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.3)",letterSpacing:"0.05em",marginBottom:6}}>{t("report.recipients")}</div>
                {emailReady
                  ?emailCfg.recipients.filter(r=>r.trim()).map((r,i)=><div key={i} style={{fontSize:11,color:"#444",marginBottom:2}}>📨 {r}</div>)
                  :<div style={{fontSize:11,color:"rgba(0,0,0,0.25)",fontStyle:"italic"}}>{t("report.none_configured")}</div>
                }
                <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.3)",letterSpacing:"0.05em",marginTop:8,marginBottom:4}}>{t("report.content")}</div>
                <div style={{fontSize:11,color:"#444",display:"flex",flexDirection:"column",gap:2}}>
                  <span>{incDefects?"✅":"⬜"} {t("report.defect_entries")} ({filtered.length})</span>
                  <span>{incDrawings?"✅":"⬜"} {t("report.pdf_drawings")} ({totalAnnotations})</span>
                  <span>{incComparisons?"✅":"⬜"} {t("report.saved_comparisons")}</span>
                </div>
              </div>
            </div>
          )}
        </div>
        <button onClick={()=>setShowContractAdvisor(v=>!v)} style={{flex:1,background:showContractAdvisor?"#1a1a1a":"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"10px 6px",color:showContractAdvisor?"#fff":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>⚖️ {t("report.advisor")}</button>
        <button onClick={()=>setShowPreview(p=>!p)} style={{flex:1,background:showPreview?"#1a1a1a":"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"10px 6px",color:showPreview?"#fff":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>👁 {t("report.preview")}</button>
        <div style={{position:"relative",flex:1,display:"flex"}}>
          <button disabled={pdfExport.active} onClick={()=>setShowExportMenu(m=>!m)} style={{flex:1,background:pdfExport.active?"rgba(255,107,0,0.15)":(showExportMenu?"#1a1a1a":"rgba(0,0,0,0.07)"),border:"none",borderRadius:10,padding:"10px 6px",color:pdfExport.active?"#ff6b00":(showExportMenu?"#fff":"#1a1a1a"),fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:pdfExport.active?"wait":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>{pdfExport.active?<><Spin size={12}/> {pdfExport.label||"Exporting…"}</>:<>📊 {t("report.export_btn")}</>}</button>
          {showExportMenu&&(
            <div style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#fff",borderRadius:12,boxShadow:"0 4px 20px rgba(0,0,0,0.15)",border:"1px solid rgba(0,0,0,0.08)",zIndex:20,minWidth:160,overflow:"hidden"}}>
              <button disabled={pdfExport.active} onClick={()=>{setShowExportMenu(false);exportReportAll(incDefects?filtered:[],incDrawings?reportDrawings:[],incComparisons?savedComparisons:[],currentProject?.name);}} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:pdfExport.active?"not-allowed":"pointer",color:"#1a1a1a",opacity:pdfExport.active?0.5:1}}>📄 {t("report.export_csv")}</button>
              <button disabled={pdfExport.active} onClick={async()=>{setShowExportMenu(false);setPdfExport({active:true,label:"Preparing report…"});try{await exportReportPdf(incDefects?filtered:[],incDrawings?reportDrawings:[],incComparisons?savedComparisons:[],currentProject?.name,company?.companyName,incDrawings?reportPins:[],contractSummary,defects,(msg)=>setPdfExport({active:true,label:msg}),{incMap,gmapsKey:local.get(GMAPS_KEY)||"",mapProvider:getMapProvider()});}catch(e){console.error("PDF export error:",e);alert("PDF export failed: "+(e?.message||e));}finally{setPdfExport({active:false,label:""});}}} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:pdfExport.active?"not-allowed":"pointer",color:"#1a1a1a",opacity:pdfExport.active?0.5:1}}>📕 {t("report.export_pdf")}</button>
              <button disabled={pdfExport.active} onClick={async()=>{setShowExportMenu(false);exportReportAll(incDefects?filtered:[],incDrawings?reportDrawings:[],incComparisons?savedComparisons:[],currentProject?.name);setPdfExport({active:true,label:"Preparing report…"});try{await new Promise(r=>setTimeout(r,600));await exportReportPdf(incDefects?filtered:[],incDrawings?reportDrawings:[],incComparisons?savedComparisons:[],currentProject?.name,company?.companyName,incDrawings?reportPins:[],contractSummary,defects,(msg)=>setPdfExport({active:true,label:msg}),{incMap,gmapsKey:local.get(GMAPS_KEY)||"",mapProvider:getMapProvider()});}catch(e){console.error("PDF export error:",e);alert("PDF export failed: "+(e?.message||e));}finally{setPdfExport({active:false,label:""});}}} style={{width:"100%",padding:"12px 16px",border:"none",borderBottom:"1px solid rgba(0,0,0,0.06)",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:pdfExport.active?"not-allowed":"pointer",color:"#ff6b00",opacity:pdfExport.active?0.5:1}}>📊 {t("report.export_all")}</button>
              <button onClick={async()=>{setShowExportMenu(false);try{const result=await exportToGoogleSheets(incDefects?filtered:[],currentProject?.name,company?.companyName);window.open(result.url,"_blank");alert("✓ Exported to Google Sheets!\n\nSpreadsheet opened in new tab.\nFuture exports will add new tabs to the same spreadsheet.");}catch(e){if(e.message.includes("not configured"))alert("Set up Google Sheets in Settings → Storage first.\n\nYou need a Google Cloud Client ID.");else alert("Google Sheets export failed: "+e.message);}}} style={{width:"100%",padding:"12px 16px",border:"none",background:"#fff",textAlign:"left",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",color:"#34a853"}}>📊 Google Sheets</button>
            </div>
          )}
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
        <button onClick={()=>setShowFilters(f=>!f)} style={{flex:1,background:showFilters?"#1a1a1a":"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"11px",color:showFilters?"#fff":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <span>{t("report.filter")}</span>
          {activeFilters>0&&<span style={{background:"#ff6b00",color:"#fff",borderRadius:20,padding:"1px 7px",fontSize:11}}>{activeFilters}</span>}
        </button>
        {activeFilters>0&&<button onClick={clearFilters} style={{background:"rgba(255,59,48,0.08)",border:"none",borderRadius:10,padding:"11px 14px",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("report.clear")}</button>}
      </div>

      {showFilters&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
          <div style={{marginBottom:12}}><div style={lbl()}>{t("report.severity_label")}</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{SEVERITY.map(s=><Chip key={s} label={(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase()} active={sevFilter.includes(s)} color={SEV_COLOR[s]} onClick={()=>toggleArr(sevFilter,setSevFilter,s)}/>)}</div></div>
          <div style={{marginBottom:12}}><div style={lbl()}>{t("report.status_label")}</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{STATUS.map(s=><Chip key={s} label={(STATUS_I18N[s]?t(STATUS_I18N[s]):s).toUpperCase()} active={statusFilter.includes(s)} color={STATUS_COLOR[s]} onClick={()=>toggleArr(statusFilter,setStatusFilter,s)}/>)}</div></div>
          {allAssignees.length>0&&<div style={{marginBottom:12}}><div style={lbl()}>{t("report.assignee_label")}</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{allAssignees.map(t=><Chip key={t} label={t} active={assigneeFilter.includes(t)} onClick={()=>toggleArr(assigneeFilter,setAssigneeFilter,t)}/>)}</div></div>}
          <div><div style={lbl()}>{t("report.date_range")}</div><div style={{display:"flex",gap:8,alignItems:"center"}}><input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{...inp,flex:1,fontSize:13}}/><span style={{color:"rgba(0,0,0,0.3)",fontSize:12}}>to</span><input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{...inp,flex:1,fontSize:13}}/></div></div>
        </div>
      )}

      {activeFilters>0&&<div style={{background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:12,color:"#ff6b00",fontWeight:600}}>{t("report.showing_filtered").replace("{shown}",filtered.length).replace("{total}",defects.length)}</div>}

      {/* Email content sections — opt in/out */}
      <div style={{background:"#fff",borderRadius:14,padding:14,marginBottom:14}}>
        <div style={lbl()}>{t("report.email_content_sections")}</div>
        <div style={{background:"rgba(255,107,0,0.06)",border:"1px solid rgba(255,107,0,0.15)",borderRadius:10,padding:"10px 12px",marginBottom:10,fontSize:11,lineHeight:1.5,color:"#666"}}>
          <span style={{fontWeight:700,color:"#ff6b00"}}>📧 {t("report.email_btn_label")}</span> {t("report.email_summary_note")} <span style={{fontWeight:700,color:"#ff6b00"}}>📕 PDF</span> {t("report.email_pdf_note")} <span style={{fontWeight:700}}>{t("report.email_export_via")}</span>.
        </div>
        {[
          {key:"defects",val:incDefects,set:setIncDefects,icon:"📋",label:t("report.defect_entries"),count:filtered.length,color:"#ff3b30"},
          {key:"drawings",val:incDrawings,set:setIncDrawings,icon:"📐",label:t("report.pdf_drawings"),count:drawingsWithAnnotations.length,sub:`${totalPins} ${t("report.pins")} · ${totalMarkups} ${t("report.markups")} · ${totalNotes} ${t("report.notes")}`,color:"#ff6b00"},
          {key:"comparisons",val:incComparisons,set:setIncComparisons,icon:"🔍",label:t("report.saved_comparisons"),count:savedComparisons.length,color:"#5856d6"},
          {key:"map",val:incMap,set:setIncMap,icon:"🗺",label:t("maps.map_view"),count:(filtered.filter(d=>typeof d.lat==="number"&&typeof d.lng==="number")).length,color:"#34aadc",sub:local.get(GMAPS_KEY)?t("maps.all_on_map"):t("maps.no_api_key")}
        ].map(sec=>(
          <button key={sec.key} onClick={()=>sec.set(v=>!v)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:6,borderRadius:10,border:`1.5px solid ${sec.val?sec.color+"40":"rgba(0,0,0,0.08)"}`,background:sec.val?sec.color+"0a":"#fafafa",cursor:"pointer",textAlign:"left"}}>
            <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${sec.val?sec.color:"rgba(0,0,0,0.15)"}`,background:sec.val?sec.color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff",flexShrink:0}}>{sec.val?"✓":""}</div>
            <div style={{flex:1}}>
              <span style={{fontSize:13,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"#1a1a1a"}}>{sec.icon} {sec.label}</span>
              {sec.sub&&sec.val&&<div style={{fontSize:10,color:"rgba(0,0,0,0.35)",marginTop:1}}>{sec.sub}</div>}
            </div>
            <span style={{fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:sec.count>0?sec.color:"rgba(0,0,0,0.25)"}}>{sec.count}</span>
          </button>
        ))}
      </div>

      {/* Preview panel */}
      {showPreview&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,border:"2px solid rgba(255,107,0,0.2)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={lbl()}>{t("report.email_preview")}</div>
            {emailReady&&<div style={{fontSize:10,color:"rgba(0,0,0,0.35)"}}>Recipients: {emailCfg.recipients.filter(r=>r.trim()).join(", ")}</div>}
          </div>
          {incDefects&&filtered.length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:800,color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>📋 DEFECTS ({filtered.length})</div>
              {filtered.slice(0,5).map(d=>(
                <div key={d.id} style={{padding:"6px 10px",marginBottom:4,background:"#fafafa",borderRadius:6,borderLeft:`3px solid ${SEV_COLOR[d.severity]||"#999"}`,fontSize:12}}>
                  <span style={{fontWeight:700}}>{d.title||"—"}</span>
                  <span style={{color:"#999",marginLeft:8,fontSize:11}}>{d.severity} · {d.status}</span>
                </div>
              ))}
              {filtered.length>5&&<div style={{fontSize:11,color:"rgba(0,0,0,0.35)",paddingLeft:10}}>... and {filtered.length-5} more</div>}
            </div>
          )}
          {incDrawings&&drawingsWithAnnotations.length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:800,color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>📐 DRAWING ANNOTATIONS ({drawingsWithAnnotations.length} drawing{drawingsWithAnnotations.length>1?"s":""})</div>
              {drawingsWithAnnotations.map(d=>{
                const notes=getDrawingNotes(d.id);const markups=getDrawingMarkup(d.id);
                return(
                  <div key={d.id} style={{padding:"6px 10px",marginBottom:4,background:"#fff8f3",borderRadius:6,borderLeft:"3px solid #ff6b00",fontSize:12}}>
                    <span style={{fontWeight:700}}>{d.name}</span>
                    <span style={{color:"#999",marginLeft:8,fontSize:11}}>{notes.length} note(s), {markups.length} markup(s)</span>
                  </div>
                );
              })}
            </div>
          )}
          {incComparisons&&savedComparisons.length>0&&(
            <div style={{marginBottom:4}}>
              <div style={{fontSize:11,fontWeight:800,color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>🔍 COMPARISONS ({savedComparisons.length})</div>
              {savedComparisons.map((sc,i)=>(
                <div key={i} style={{padding:"6px 10px",marginBottom:4,background:"#f5f3ff",borderRadius:6,borderLeft:"3px solid #5856d6",fontSize:12}}>
                  <span style={{fontWeight:700}}>{sc.baseName} → {sc.targetName}</span>
                  <span style={{color:"#999",marginLeft:8,fontSize:11}}>+{sc.totalAdded||0} / -{sc.totalRemoved||0}{sc.aiReport?" · AI report":""}  </span>
                </div>
              ))}
            </div>
          )}
          {!incDefects&&!incDrawings&&!incComparisons&&<div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",fontSize:12,padding:10}}>{t("report.no_sections_selected")}</div>}
        </div>
      )}

      {sendRes&&(
        <div style={{background:sendRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${sendRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:14,color:sendRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>
          {sendRes==="success"?<>✓ Sent to: {emailCfg.recipients.filter(r=>r.trim()).join(", ")}</>:"✗ Failed to send. Check SMTP settings in PocketBase admin."}
        </div>
      )}

      {/* Report tally — shows totals for all selected sections */}
      <div style={{background:"#1a1a1a",borderRadius:14,padding:"7px 8px",marginBottom:16}}>
        {(() => {
          const tallyCols = (incDefects?1:0)+(incDrawings?1:0)+(incComparisons?1:0);
          if(!tallyCols) return <div style={{fontSize:13,color:"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("report.no_sections_selected")}</div>;
          return (
        <div style={{display:"grid",gridTemplateColumns:`repeat(${tallyCols}, minmax(0, 1fr))`,gap:10,alignItems:"start"}}>
          {incDefects&&<div style={{minWidth:0}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",minHeight:24,lineHeight:1.15,display:"flex",alignItems:"flex-end"}}>{t("report.defect_entries").toUpperCase()}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:44,fontWeight:800,color:"#ff3b30",lineHeight:1,marginTop:2}}>{total}</div>
          </div>}
          {incDrawings&&<div style={{minWidth:0}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",minHeight:24,lineHeight:1.15,display:"flex",alignItems:"flex-end"}}>{t("report.pdf_drawings").toUpperCase()}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:44,fontWeight:800,color:"#ff6b00",lineHeight:1,marginTop:2}}>{drawingsWithAnnotations.length}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",marginTop:2,lineHeight:1.2,overflowWrap:"anywhere"}}>{totalPins} {t("report.pins")} · {totalMarkups} {t("report.markups")} · {totalNotes} {t("report.notes")}</div>
          </div>}
          {incComparisons&&<div style={{minWidth:0}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",minHeight:24,lineHeight:1.15,display:"flex",alignItems:"flex-end"}}>{t("report.saved_comparisons").toUpperCase()}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:44,fontWeight:800,color:"#5856d6",lineHeight:1,marginTop:2}}>{savedComparisons.length}</div>
          </div>}
        </div>
          );
        })()}
      </div>

      {incDefects&&<>
      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
        <div style={lbl()}>{t("report.by_severity")}</div>
        {bySev.map(({s,count})=>(
          <div key={s} style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:SEV_COLOR[s]}}>{(SEV_I18N[s]?t(SEV_I18N[s]):s).toUpperCase()}</span>
              <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13}}>{count}</span>
            </div>
            <div style={{background:"rgba(0,0,0,0.06)",borderRadius:4,height:6,overflow:"hidden"}}>
              <div style={{background:SEV_COLOR[s],height:"100%",width:total?`${(count/total)*100}%`:"0%",borderRadius:4}}/>
            </div>
          </div>
        ))}
      </div>

      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
        <div style={lbl()}>{t("report.by_status")}</div>
        <div style={{display:"flex",gap:10}}>
          {byStatus.map(({s,count})=>(
            <div key={s} style={{flex:1,textAlign:"center",padding:"12px 8px",background:STATUS_COLOR[s]+"12",borderRadius:10}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:STATUS_COLOR[s]}}>{count}</div>
              <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em"}}>{(STATUS_I18N[s]?t(STATUS_I18N[s]):s).toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {byAssignee.length>0&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
          <div style={lbl()}>{t("report.by_assignee")}</div>
          {byAssignee.map(({t:name,open,total:tot})=>(
            <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
              <span style={{fontSize:13,color:"#1a1a1a"}}>{name}</span>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {open>0&&<span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"#ff3b30",background:"rgba(255,59,48,0.1)",padding:"2px 8px",borderRadius:10}}>{open} {t("status.open").toLowerCase()}</span>}
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,color:"rgba(0,0,0,0.4)"}}>{tot} {t("report.total")}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      </>}

      {showContractAdvisor&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,border:"2px solid rgba(88,86,214,0.2)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:10}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#1a1a1a"}}>⚖️ CONTRACT ADVISOR</div>
            {contractBusy&&<div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#5856d6",fontWeight:700}}><Spin size={12}/><span>RUNNING</span></div>}
          </div>

          <div style={{background:"rgba(88,86,214,0.05)",borderRadius:10,padding:"12px 14px",marginBottom:12,fontSize:12,lineHeight:1.6,color:"#2f2e55"}}>
            AI reads your contract PDFs (PSSCOC, REDAS, SIA) and cross-references the <b>{filtered.length} defect{filtered.length!==1?"s":""}</b> in this report to advise:<br/>
            <span style={{color:"#5856d6",fontWeight:700}}>Applicable clauses</span> · <span style={{color:"#5856d6",fontWeight:700}}>Responsible parties</span> · <span style={{color:"#5856d6",fontWeight:700}}>Impact & considerations</span> · <span style={{color:"#5856d6",fontWeight:700}}>Actionable follow-ups</span>
          </div>

          {!contractBusy&&!contractSummary&&(
            <button disabled={contractBusy} onClick={runContractAdvisor} style={{width:"100%",background:"#5856d6",border:"none",borderRadius:10,padding:"14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:10}}>
              <span>⚖️</span><span>RUN CONTRACT ADVISOR</span>
            </button>
          )}

          {contractProgress.length>0&&(
            <div style={{background:"rgba(88,86,214,0.06)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:800,color:"#5856d6",letterSpacing:"0.05em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>PROGRESS</div>
              {contractProgress.map((p,i)=><div key={i} style={{fontSize:11,color:"#2f2e55",marginBottom:3}}>• {p}</div>)}
            </div>
          )}

          {contractError&&<div style={{background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.25)",borderRadius:10,padding:"10px 12px",fontSize:12,color:"#cc0000",fontWeight:600,marginBottom:10}}>{contractError}</div>}

          {contractSummary&&(
            <div>
              <div style={{background:"rgba(26,26,26,0.03)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:10,padding:"12px 14px",marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:800,color:"rgba(0,0,0,0.5)",letterSpacing:"0.05em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:8}}>CONTRACT CLAUSE ADVISORY</div>
                <div style={{whiteSpace:"pre-wrap",fontSize:12,lineHeight:1.6,color:"#1a1a1a"}}>{contractSummary}</div>
              </div>
              {contractTokens&&(
                <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                  <div style={{background:"rgba(88,86,214,0.06)",borderRadius:8,padding:"6px 10px",fontSize:10,color:"#5856d6",fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif"}}>{contractTokens.provider}</div>
                  <div style={{background:"rgba(0,0,0,0.04)",borderRadius:8,padding:"6px 10px",fontSize:10,color:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif"}}>Prompt: <b>{contractTokens.prompt.toLocaleString()}</b></div>
                  <div style={{background:"rgba(0,0,0,0.04)",borderRadius:8,padding:"6px 10px",fontSize:10,color:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif"}}>Completion: <b>{contractTokens.completion.toLocaleString()}</b></div>
                  <div style={{background:"rgba(0,0,0,0.04)",borderRadius:8,padding:"6px 10px",fontSize:10,color:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif"}}>Total: <b>{contractTokens.total.toLocaleString()}</b> tokens</div>
                </div>
              )}
              <div style={{background:"rgba(255,149,0,0.08)",border:"1px solid rgba(255,149,0,0.2)",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                <div style={{fontSize:10,color:"#996100",lineHeight:1.5}}>⚠ <b>Disclaimer:</b> This advisory is generated by AI for reference only. It is not legal advice. Always verify clause references against your actual contract documents and consult qualified professionals before acting on contractual matters. AI outputs may vary between runs — cross-check cited clause numbers with the source documents.</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={runContractAdvisor} disabled={contractBusy} style={{flex:1,background:"#5856d6",border:"none",borderRadius:10,padding:"11px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",opacity:contractBusy?0.7:1}}>
                  {contractBusy?<><Spin size={12}/> ANALYZING...</>:"RE-RUN"}
                </button>
                <button onClick={()=>{setContractSummary("");setContractError("");setContractProgress([]);setContractTokens(null);}} style={{background:"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"11px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CLEAR</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Map provider selection ───────────────────────────────────────
// "osm"  = OpenStreetMap via Leaflet (free, no key)   [default]
// "gmaps"= Google Maps JS SDK (needs API key + billing)
function getMapProvider(){
  const p=local.get(MAP_PROVIDER_KEY);
  if(p==="gmaps"&&(local.get(GMAPS_KEY)||""))return "gmaps";
  return "osm";
}

// ── Google Maps SDK loader ────────────────────────────────────────
let _gmapsLoadingPromise=null;
function loadGoogleMaps(apiKey){
  if(!apiKey)return Promise.reject(new Error("no-api-key"));
  if(window.google&&window.google.maps&&window.google.maps.places)return Promise.resolve();
  if(_gmapsLoadingPromise)return _gmapsLoadingPromise;
  _gmapsLoadingPromise=new Promise((resolve,reject)=>{
    const cbName="__gmapsReady_"+Date.now();
    window[cbName]=()=>{delete window[cbName];resolve();};
    const s=document.createElement("script");
    s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=${cbName}`;
    s.async=true;s.defer=true;
    s.onerror=()=>{_gmapsLoadingPromise=null;reject(new Error("gmaps-load-failed"));};
    document.head.appendChild(s);
  });
  return _gmapsLoadingPromise;
}

// ── Leaflet readiness — script is <script defer> in index.html ───
function waitForLeaflet(timeoutMs){
  if(window.L)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const deadline=Date.now()+(timeoutMs||8000);
    const tick=()=>{if(window.L)resolve();else if(Date.now()>deadline)reject(new Error("leaflet-load-timeout"));else setTimeout(tick,80);};
    tick();
  });
}

// ── Nominatim geocoding (free, rate-limited 1 req/sec) ───────────
async function geocodeNominatim(query){
  if(!query||!query.trim())return null;
  const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query.trim())}`;
  try{
    const r=await fetch(url,{headers:{"Accept-Language":"en"}});
    if(!r.ok)return null;
    const items=await r.json();
    if(!items||!items.length)return null;
    return{lat:parseFloat(items[0].lat),lng:parseFloat(items[0].lon),label:items[0].display_name};
  }catch{return null;}
}

// ── Static map URL builders (for PDF export & entry detail) ──────
function staticMapUrl(provider,lat,lng,zoom,size){
  const z=zoom||17;
  const s=size||"600x240";
  if(provider==="gmaps"){
    const key=local.get(GMAPS_KEY)||"";
    if(!key)return null;
    return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${z}&size=${s}&maptype=hybrid&markers=color:red%7C${lat},${lng}&key=${encodeURIComponent(key)}`;
  }
  // OSM (free, via staticmap.openstreetmap.de)
  const[w,h]=s.split("x");
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${z}&size=${w}x${h}&markers=${lat},${lng},red-pushpin`;
}

// Per-project default map view (localStorage until wired to project record)
function getProjectMapDefault(projectId){
  if(!projectId)return MAP_FALLBACK_CENTER;
  return local.get(MAP_DEFAULT_VIEW_KEY_PREFIX+projectId)||MAP_FALLBACK_CENTER;
}
function setProjectMapDefault(projectId,view){
  if(!projectId)return;
  local.set(MAP_DEFAULT_VIEW_KEY_PREFIX+projectId,view);
}

// ── Maps Settings (provider + optional Google key) ───────────────
const MAP_PROVIDERS=[
  {id:"osm",label:"OpenStreetMap",icon:"🌍",desc:"Free · No key · No billing · Works out of the box",color:"#30d158"},
  {id:"gmaps",label:"Google Maps",icon:"🗺",desc:"Satellite + Places search · Needs API key + billing",color:"#4285f4"},
];
function MapsSettings({onClose}){
  const[provider,setProvider]=useState(()=>local.get(MAP_PROVIDER_KEY)||"osm");
  const[apiKey,setApiKey]=useState(()=>local.get(GMAPS_KEY)||"");
  const[saved,setSaved]=useState(false);
  const[testing,setTesting]=useState(false);
  const[testRes,setTestRes]=useState(null);
  const save=()=>{
    local.set(MAP_PROVIDER_KEY,provider);
    local.set(GMAPS_KEY,apiKey.trim());
    setSaved(true);setTimeout(()=>setSaved(false),2000);
  };
  const test=async()=>{
    setTesting(true);setTestRes(null);
    try{
      _gmapsLoadingPromise=null;
      if(window.google&&window.google.maps)delete window.google.maps;
      await loadGoogleMaps(apiKey.trim());
      setTestRes("success");
    }catch{setTestRes("fail");}
    setTesting(false);
  };
  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title={t("maps.title")}/>
      <div style={{padding:20}}>
        <p style={{fontSize:13,color:"rgba(0,0,0,0.6)",marginBottom:16,lineHeight:1.5}}>{t("maps.maps_desc")}</p>
        <label style={{display:"block",fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.5)",letterSpacing:"0.12em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>MAP PROVIDER</label>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:18}}>
          {MAP_PROVIDERS.map(p=>(
            <button key={p.id} onClick={()=>{setProvider(p.id);setTestRes(null);}} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`2px solid ${provider===p.id?p.color:"rgba(0,0,0,0.1)"}`,background:provider===p.id?p.color+"10":"#fff",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:20,flexShrink:0}}>{p.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#1a1a1a"}}>{p.label}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.5)",marginTop:2}}>{p.desc}</div>
              </div>
              {provider===p.id&&<span style={{color:p.color,fontSize:18,fontWeight:700}}>✓</span>}
            </button>
          ))}
        </div>
        {provider==="gmaps"&&<>
          <div style={{background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:12,padding:14,marginBottom:14}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#1a1a1a",marginBottom:10}}>Google Maps Setup</div>
            {[
              {n:1,txt:<>Open <a href="https://console.cloud.google.com/google/maps-apis/start" target="_blank" rel="noopener noreferrer" style={{color:"#4285f4",fontWeight:700,textDecoration:"underline"}}>console.cloud.google.com/google/maps-apis/start</a> and sign in with Google.</>},
              {n:2,txt:<>Create (or pick) a project, then <b>enable billing</b> — Maps has a ~$200/mo free credit so most small teams never get charged.</>},
              {n:3,txt:<>From APIs & Services → Library, enable these three:<br/><span style={{fontFamily:"monospace",fontSize:11,color:"#4285f4"}}>Maps JavaScript API · Places API · Maps Static API</span></>},
              {n:4,txt:<>APIs & Services → Credentials → <b>Create credentials → API key</b>. (Optional: restrict to <code style={{fontSize:11}}>http://localhost:8080/*</code> and your production domain.)</>},
              {n:5,txt:<>Copy the key and paste below → <b>TEST KEY</b> → <b>SAVE SETTINGS</b>.</>},
            ].map(s=>(
              <div key={s.n} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:8,fontSize:12,lineHeight:1.5,color:"rgba(0,0,0,0.7)"}}>
                <span style={{width:22,height:22,borderRadius:"50%",background:"#4285f4",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12}}>{s.n}</span>
                <span style={{flex:1}}>{s.txt}</span>
              </div>
            ))}
            <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.18)",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#1a7b3a",marginTop:10,lineHeight:1.5}}>
              💡 <b>Free tier:</b> Google gives $200/mo free credit. Typical small-team usage (map loads + static thumbnails) is well under that.
            </div>
          </div>
          <label style={{display:"block",fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.5)",letterSpacing:"0.12em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>{t("maps.api_key")}</label>
          <input type="text" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={t("maps.api_key_placeholder")} style={{width:"100%",padding:"12px 14px",fontSize:14,borderRadius:10,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",boxSizing:"border-box",marginBottom:14}}/>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <button onClick={test} disabled={!apiKey.trim()||testing} style={{padding:"11px 14px",borderRadius:10,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",color:"rgba(0,0,0,0.7)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:apiKey.trim()&&!testing?"pointer":"not-allowed"}}>{testing?"…":t("maps.test_key")}</button>
          </div>
          {testRes==="success"&&<div style={{fontSize:13,color:"#30d158",marginBottom:10}}>{t("maps.test_ok")}</div>}
          {testRes==="fail"&&<div style={{fontSize:13,color:"#ff3b30",marginBottom:10}}>{t("maps.test_failed")}</div>}
        </>}
        <button onClick={save} style={{width:"100%",padding:"12px 14px",borderRadius:10,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ "+t("actions.save"):t("actions.save_settings")}</button>
      </div>
    </div>
  );
}

// ── Tag on Map (Google Maps pin canvas) ──────────────────────────
function MapPanel({currentProject,member,defects,onSaveEntry,company,onSnapped}){
  const mapRef=useRef(null);
  const searchRef=useRef(null);
  const mapObj=useRef(null);
  const markersRef=useRef({existing:[],pending:null});
  const clusterRef=useRef(null); // Leaflet MarkerClusterGroup or gmaps MarkerClusterer
  const providerRef=useRef(getMapProvider());
  const[status,setStatus]=useState("loading"); // loading | ready | error
  const[pendingPin,setPendingPin]=useState(null);
  const[savedDefault,setSavedDefault]=useState(false);
  const[qTitle,setQTitle]=useState("");
  const[qSev,setQSev]=useState("Minor");
  const[saving,setSaving]=useState(false);
  const[searching,setSearching]=useState(false);
  const[pinMode,setPinMode]=useState(true);
  const[showList,setShowList]=useState(false);
  const[markupTool,setMarkupTool]=useState(null); // null | "rect" | "circle" | "line" | "text" | "arrow" | "dimension" | "stamp" | "freehand" | "photo"
  const[mapMarkups,setMapMarkups]=useState([]);   // session-only, not yet persisted
  const[pendingPhoto,setPendingPhoto]=useState(null); // {dataUrl, aspect}
  const markupDrawRef=useRef(null);               // {tool, first:{lat,lng}, tempLayer, points[]}
  const markupLayersRef=useRef([]);
  const photoInputRef=useRef(null);
  const provider=providerRef.current;
  const canEdit=member?.role!=="viewer";

  // Filter defects that have GPS coords for current project
  const mapDefects=(defects||[]).filter(d=>typeof d.lat==="number"&&typeof d.lng==="number");

  // ── Google Maps path ───────────────────────────────────────────
  useEffect(()=>{
    if(provider!=="gmaps")return;
    const apiKey=local.get(GMAPS_KEY)||"";
    let cancelled=false;
    loadGoogleMaps(apiKey).then(()=>{
      if(cancelled||!mapRef.current)return;
      const g=window.google.maps;
      const view=getProjectMapDefault(currentProject?.id);
      const map=new g.Map(mapRef.current,{
        center:{lat:view.lat,lng:view.lng},
        zoom:view.zoom||17,
        mapTypeId:"hybrid",
        streetViewControl:false,
        mapTypeControl:true,
        fullscreenControl:false,
      });
      mapObj.current=map;
      if(searchRef.current){
        const ac=new g.places.Autocomplete(searchRef.current,{fields:["geometry","name"]});
        ac.bindTo("bounds",map);
        ac.addListener("place_changed",()=>{
          const place=ac.getPlace();
          if(!place.geometry)return;
          if(place.geometry.viewport)map.fitBounds(place.geometry.viewport);
          else{map.setCenter(place.geometry.location);map.setZoom(17);}
        });
      }
      if(canEdit){
        map.addListener("click",e=>{
          const tool=markupToolRef.current;
          if(tool){handleGmapsMarkupClick(e.latLng,map,g,tool);return;}
          if(!pinModeRef.current)return;
          setPendingPin({lat:e.latLng.lat(),lng:e.latLng.lng()});
          if(markersRef.current.pending)markersRef.current.pending.setMap(null);
          const pendingSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="10" fill="#ff6b00" stroke="#fff" stroke-width="3"/><text x="17" y="18" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="900" fill="#fff" font-family="sans-serif">+</text></svg>`;
          markersRef.current.pending=new g.Marker({position:e.latLng,map,icon:{url:"data:image/svg+xml;utf8,"+encodeURIComponent(pendingSvg),scaledSize:new g.Size(34,34),anchor:new g.Point(17,17)},zIndex:9999});
        });
        map.addListener("dblclick",()=>{
          if(markupToolRef.current==="line"&&markupDrawRef.current?.points?.length>=2)finishPolyline();
        });
      }
      setStatus("ready");
      const nudge=()=>{try{g.event.trigger(map,"resize");}catch{}};
      setTimeout(nudge,80);
      let ro=null;
      if(window.ResizeObserver&&mapRef.current){ro=new ResizeObserver(nudge);ro.observe(mapRef.current);}
      window.addEventListener("resize",nudge);
      window.addEventListener("orientationchange",nudge);
      map._siteshrimpCleanupResize=()=>{
        try{ro&&ro.disconnect();}catch{}
        window.removeEventListener("resize",nudge);
        window.removeEventListener("orientationchange",nudge);
      };
    }).catch(()=>setStatus("error"));
    return()=>{
      cancelled=true;
      if(mapObj.current&&mapObj.current._siteshrimpCleanupResize){try{mapObj.current._siteshrimpCleanupResize();}catch{}}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[provider,currentProject?.id]);

  // Keep pinMode in a ref so map click handlers see the latest value
  const pinModeRef=useRef(pinMode);
  useEffect(()=>{pinModeRef.current=pinMode;},[pinMode]);
  // When siblings (Quick Log card, markup palette) mount/unmount, the map
  // container can resize — tell Leaflet / gmaps so tiles don't sit offset.
  useEffect(()=>{
    if(!mapObj.current)return;
    const run=()=>{
      try{if(provider==="osm"&&mapObj.current.invalidateSize)mapObj.current.invalidateSize();}catch{}
      try{if(provider==="gmaps"&&window.google?.maps)window.google.maps.event.trigger(mapObj.current,"resize");}catch{}
    };
    run();setTimeout(run,200);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pendingPin,markupTool,showList]);
  const markupToolRef=useRef(markupTool);
  useEffect(()=>{markupToolRef.current=markupTool;},[markupTool]);
  // pendingPhoto is read from the long-lived map click handler registered
  // once on mount; without a ref, it stays frozen at the first-render null.
  const pendingPhotoRef=useRef(pendingPhoto);
  useEffect(()=>{pendingPhotoRef.current=pendingPhoto;},[pendingPhoto]);

  // ── Photo tool: open file picker when activated ───────────────
  useEffect(()=>{
    if(markupTool!=="photo"||pendingPhoto)return;
    photoInputRef.current?.click();
  },[markupTool,pendingPhoto]);

  const onPickMarkupPhoto=(e)=>{
    const file=e.target.files?.[0];
    if(!file){setMarkupTool(null);return;}
    e.target.value="";
    const img=new Image();
    img.onload=()=>{
      const maxDim=1200;
      const sc=Math.min(1,maxDim/Math.max(img.width,img.height));
      const cw=Math.round(img.width*sc),ch=Math.round(img.height*sc);
      const cnv=document.createElement("canvas");
      cnv.width=cw;cnv.height=ch;
      cnv.getContext("2d").drawImage(img,0,0,cw,ch);
      setPendingPhoto({dataUrl:cnv.toDataURL("image/jpeg",0.82),aspect:ch/cw});
    };
    img.onerror=()=>{alert("Could not load image.");setMarkupTool(null);};
    const fr=new FileReader();
    fr.onload=ev=>{img.src=ev.target.result;};
    fr.readAsDataURL(file);
  };

  // ── Freehand on Google Maps: transparent canvas overlay captures
  // pointer events; pixel coords are converted to lat/lng via an
  // OverlayView's projection, then saved as a polyline of geo points.
  useEffect(()=>{
    if(provider!=="gmaps"||markupTool!=="freehand"||!mapObj.current||!window.google?.maps)return;
    const g=window.google.maps,map=mapObj.current,mapDiv=map.getDiv();
    // Projection helper
    const helper=new g.OverlayView();
    let proj=null;
    helper.onAdd=function(){proj=this.getProjection();};
    helper.draw=function(){if(!proj)proj=this.getProjection();};
    helper.onRemove=function(){};
    helper.setMap(map);
    // Overlay canvas
    const canvas=document.createElement("canvas");
    const resize=()=>{canvas.width=mapDiv.clientWidth;canvas.height=mapDiv.clientHeight;};
    Object.assign(canvas.style,{position:"absolute",top:"0",left:"0",width:"100%",height:"100%",zIndex:"9999",cursor:"crosshair",touchAction:"none"});
    resize();
    mapDiv.appendChild(canvas);
    const ctx=canvas.getContext("2d");
    ctx.strokeStyle="#ff6b00";ctx.lineWidth=3;ctx.lineCap="round";ctx.lineJoin="round";
    // Freeze map gestures while drawing
    const prev={draggable:map.get("draggable"),scrollwheel:map.get("scrollwheel"),disableDoubleClickZoom:map.get("disableDoubleClickZoom"),gestureHandling:map.get("gestureHandling")};
    map.setOptions({draggable:false,scrollwheel:false,disableDoubleClickZoom:true,gestureHandling:"none"});
    let drawing=false,points=[];
    const getPx=e=>{const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    const toLL=px=>{if(!proj)return null;const ll=proj.fromContainerPixelToLatLng(new g.Point(px.x,px.y));return ll?{lat:ll.lat(),lng:ll.lng()}:null;};
    const onDown=e=>{e.preventDefault();drawing=true;points=[];const px=getPx(e);const ll=toLL(px);if(ll)points.push(ll);ctx.beginPath();ctx.moveTo(px.x,px.y);canvas.setPointerCapture?.(e.pointerId);};
    const onMove=e=>{if(!drawing)return;const px=getPx(e);const ll=toLL(px);if(ll)points.push(ll);ctx.lineTo(px.x,px.y);ctx.stroke();};
    const onUp=e=>{if(!drawing)return;drawing=false;try{canvas.releasePointerCapture?.(e.pointerId);}catch{}if(points.length>=2)addMarkup({id:"mm_"+Date.now(),type:"freehand",points:points.slice(),color:"#ff6b00"});points=[];setMarkupTool(null);};
    canvas.addEventListener("pointerdown",onDown);
    canvas.addEventListener("pointermove",onMove);
    canvas.addEventListener("pointerup",onUp);
    canvas.addEventListener("pointercancel",onUp);
    window.addEventListener("resize",resize);
    return()=>{
      canvas.removeEventListener("pointerdown",onDown);
      canvas.removeEventListener("pointermove",onMove);
      canvas.removeEventListener("pointerup",onUp);
      canvas.removeEventListener("pointercancel",onUp);
      window.removeEventListener("resize",resize);
      try{mapDiv.removeChild(canvas);}catch{}
      try{helper.setMap(null);}catch{}
      map.setOptions(prev);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[markupTool,provider,status]);

  // ── Freehand on Leaflet: drag across map with panning disabled ─
  useEffect(()=>{
    if(provider!=="osm"||markupTool!=="freehand"||!mapObj.current||!window.L)return;
    const L=window.L,map=mapObj.current;
    map.dragging.disable();map.getContainer().style.cursor="crosshair";
    let points=[],tempLayer=null,drawing=false;
    const onDown=e=>{drawing=true;points=[{lat:e.latlng.lat,lng:e.latlng.lng}];if(tempLayer)tempLayer.remove();tempLayer=L.polyline([],{color:"#ff6b00",weight:3,opacity:0.85}).addTo(map);};
    const onMove=e=>{if(!drawing)return;points.push({lat:e.latlng.lat,lng:e.latlng.lng});tempLayer.setLatLngs(points.map(p=>[p.lat,p.lng]));};
    const onUp=()=>{
      if(!drawing)return;
      drawing=false;
      if(points.length>=2){
        addMarkup({id:"mm_"+Date.now(),type:"freehand",points:points.slice(),color:"#ff6b00"});
      }
      if(tempLayer){try{tempLayer.remove();}catch{}tempLayer=null;}
      points=[];setMarkupTool(null);
    };
    map.on("mousedown",onDown);map.on("mousemove",onMove);map.on("mouseup",onUp);
    return()=>{
      map.off("mousedown",onDown);map.off("mousemove",onMove);map.off("mouseup",onUp);
      map.dragging.enable();map.getContainer().style.cursor="";
      if(tempLayer)try{tempLayer.remove();}catch{}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[markupTool,provider,status]);

  // ── Map markup: load + persist ─────────────────────────────────
  // Stored in PocketBase `map_markups` collection with geo stored as a
  // JSON blob so all shape variants share a single row shape.
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    let cancelled=false;
    DB.mapMarkups.list(`companyId = "${company.companyId}" && projectId = "${currentProject.id}"`,"created").then(items=>{
      if(cancelled)return;
      setMapMarkups((items||[]).map(it=>({id:it.id,type:it.type,color:it.color||"#ff6b00",text:it.text||"",...(it.geo||{})})));
    }).catch(()=>{/* collection missing — stay session-only */});
    return()=>{cancelled=true;};
  },[company?.companyId,currentProject?.id]);

  const persistMarkup=async(m)=>{
    if(!company?.companyId||!currentProject?.id)return m;
    const geo={};
    if(m.a)geo.a=m.a;if(m.b)geo.b=m.b;
    if(m.center)geo.center=m.center;if(m.radius!=null)geo.radius=m.radius;
    if(m.points)geo.points=m.points;
    if(m.pos)geo.pos=m.pos;
    try{
      const saved=await DB.mapMarkups.create({companyId:company.companyId,projectId:currentProject.id,type:m.type,color:m.color,text:m.text||"",geo,createdBy:member?.name||""});
      return{...m,id:saved.id};
    }catch{return m;/* leave local id if save fails */}
  };
  const addMarkup=async(m)=>{
    setMapMarkups(prev=>[...prev,m]); // optimistic
    const saved=await persistMarkup(m);
    if(saved.id!==m.id)setMapMarkups(prev=>prev.map(x=>x===m?saved:x.id===m.id?saved:x));
  };

  // ── Map markup: click handlers and finish logic ────────────────
  const finishPolyline=()=>{
    const d=markupDrawRef.current;
    if(!d||d.tool!=="line"||!d.points||d.points.length<2)return;
    addMarkup({id:"mm_"+Date.now(),type:"line",points:d.points,color:"#ff6b00"});
    // Clean up temp preview — Leaflet uses removeLayer, gmaps uses setMap(null)
    if(d.tempLayer){
      if(d.tempLayer.setMap)try{d.tempLayer.setMap(null);}catch{}
      else if(mapObj.current&&mapObj.current.removeLayer)try{mapObj.current.removeLayer(d.tempLayer);}catch{}
    }
    markupDrawRef.current=null;
    setMarkupTool(null);
  };
  // Pick a stamp text from preset list (or custom)
  const promptStamp=()=>{
    const txt=prompt("Stamp text (APPROVED, REJECTED, REVIEWED, HOLD, SURVEYED, etc.):","APPROVED");
    return txt&&txt.trim()?txt.trim().toUpperCase():"";
  };

  // Haversine distance in metres between two {lat,lng}
  const haversine=(a,b)=>{
    const R=6371000;
    const dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
    const la1=a.lat*Math.PI/180,la2=b.lat*Math.PI/180;
    const hav=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
    return 2*R*Math.atan2(Math.sqrt(hav),Math.sqrt(1-hav));
  };
  const fmtMetres=(m)=>m>=1000?(m/1000).toFixed(2)+" km":Math.round(m)+" m";

  const handleGmapsMarkupClick=(latLng,map,g,tool)=>{
    const pt={lat:latLng.lat(),lng:latLng.lng()};
    if(tool==="text"){
      const label=prompt("Text label:");
      if(label&&label.trim()){
        addMarkup({id:"mm_"+Date.now(),type:"text",pos:pt,text:label.trim(),color:"#ff6b00"});
      }
      setMarkupTool(null);return;
    }
    if(tool==="stamp"){
      const label=promptStamp();
      if(label)addMarkup({id:"mm_"+Date.now(),type:"stamp",pos:pt,text:label,color:"#34c759"});
      setMarkupTool(null);return;
    }
    if(tool==="photo"&&pendingPhotoRef.current){
      const ph=pendingPhotoRef.current;
      const widthM=200,aspect=ph.aspect||0.75,heightM=widthM*aspect;
      const mPerDegLat=111320,mPerDegLng=111320*Math.cos(pt.lat*Math.PI/180);
      const dLat=(heightM/2)/mPerDegLat,dLng=(widthM/2)/mPerDegLng;
      addMarkup({id:"mm_"+Date.now(),type:"photo",a:{lat:pt.lat+dLat,lng:pt.lng-dLng},b:{lat:pt.lat-dLat,lng:pt.lng+dLng},dataUrl:ph.dataUrl,color:"#ff6b00"});
      setPendingPhoto(null);setMarkupTool(null);return;
    }
    if(tool==="arrow"||tool==="dimension"){
      const d=markupDrawRef.current;
      if(!d||d.tool!==tool){markupDrawRef.current={tool,first:pt};return;}
      const a=d.first,b=pt;
      if(tool==="arrow")addMarkup({id:"mm_"+Date.now(),type:"arrow",a,b,color:"#ff6b00"});
      else addMarkup({id:"mm_"+Date.now(),type:"dimension",a,b,color:"#5856d6",distance:haversine(a,b)});
      markupDrawRef.current=null;setMarkupTool(null);return;
    }
    if(tool==="rect"||tool==="circle"){
      const d=markupDrawRef.current;
      if(!d||d.tool!==tool){markupDrawRef.current={tool,first:pt};return;}
      const a=d.first,b=pt;
      if(tool==="rect"){
        addMarkup({id:"mm_"+Date.now(),type:"rect",a,b,color:"#ff6b00"});
      }else{
        const R=6371000;
        const dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
        const la1=a.lat*Math.PI/180,la2=b.lat*Math.PI/180;
        const hav=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
        const radius=2*R*Math.atan2(Math.sqrt(hav),Math.sqrt(1-hav));
        addMarkup({id:"mm_"+Date.now(),type:"circle",center:a,radius,color:"#ff6b00"});
      }
      markupDrawRef.current=null;setMarkupTool(null);return;
    }
    if(tool==="line"){
      const d=markupDrawRef.current;
      const pts=d?.points||[];
      const next=[...pts,pt];
      if(d?.tempLayer)try{d.tempLayer.setMap(null);}catch{}
      const tempLayer=new g.Polyline({path:next.map(p=>({lat:p.lat,lng:p.lng})),strokeColor:"#ff6b00",strokeWeight:3,strokeOpacity:0.75,map:mapObj.current});
      markupDrawRef.current={tool:"line",points:next,tempLayer};
      return;
    }
  };

  const handleMapMarkupClick=(latlng,map,L,tool)=>{
    const pt={lat:latlng.lat,lng:latlng.lng};
    if(tool==="text"){
      const label=prompt("Text label:");
      if(label&&label.trim())addMarkup({id:"mm_"+Date.now(),type:"text",pos:pt,text:label.trim(),color:"#ff6b00"});
      setMarkupTool(null);return;
    }
    if(tool==="stamp"){
      const label=promptStamp();
      if(label)addMarkup({id:"mm_"+Date.now(),type:"stamp",pos:pt,text:label,color:"#34c759"});
      setMarkupTool(null);return;
    }
    if(tool==="photo"&&pendingPhotoRef.current){
      const ph=pendingPhotoRef.current;
      const widthM=200,aspect=ph.aspect||0.75,heightM=widthM*aspect;
      const mPerDegLat=111320,mPerDegLng=111320*Math.cos(pt.lat*Math.PI/180);
      const dLat=(heightM/2)/mPerDegLat,dLng=(widthM/2)/mPerDegLng;
      addMarkup({id:"mm_"+Date.now(),type:"photo",a:{lat:pt.lat+dLat,lng:pt.lng-dLng},b:{lat:pt.lat-dLat,lng:pt.lng+dLng},dataUrl:ph.dataUrl,color:"#ff6b00"});
      setPendingPhoto(null);setMarkupTool(null);return;
    }
    if(tool==="arrow"||tool==="dimension"){
      const d=markupDrawRef.current;
      if(!d||d.tool!==tool){markupDrawRef.current={tool,first:pt};return;}
      const a=d.first,b=pt;
      if(tool==="arrow")addMarkup({id:"mm_"+Date.now(),type:"arrow",a,b,color:"#ff6b00"});
      else addMarkup({id:"mm_"+Date.now(),type:"dimension",a,b,color:"#5856d6",distance:haversine(a,b)});
      markupDrawRef.current=null;setMarkupTool(null);return;
    }
    if(tool==="rect"||tool==="circle"){
      const d=markupDrawRef.current;
      if(!d||d.tool!==tool){
        markupDrawRef.current={tool,first:{lat:latlng.lat,lng:latlng.lng}};
        return;
      }
      const a=d.first,b={lat:latlng.lat,lng:latlng.lng};
      if(tool==="rect"){
        addMarkup({id:"mm_"+Date.now(),type:"rect",a,b,color:"#ff6b00"});
      }else{
        const R=6371000;
        const dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
        const la1=a.lat*Math.PI/180,la2=b.lat*Math.PI/180;
        const hav=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
        const radius=2*R*Math.atan2(Math.sqrt(hav),Math.sqrt(1-hav));
        addMarkup({id:"mm_"+Date.now(),type:"circle",center:a,radius,color:"#ff6b00"});
      }
      markupDrawRef.current=null;
      setMarkupTool(null);
      return;
    }
    if(tool==="line"){
      const d=markupDrawRef.current;
      const pts=d?.points||[];
      const next=[...pts,{lat:latlng.lat,lng:latlng.lng}];
      if(d?.tempLayer&&mapObj.current)mapObj.current.removeLayer(d.tempLayer);
      const tempLayer=L.polyline(next.map(p=>[p.lat,p.lng]),{color:"#ff6b00",weight:3,dashArray:"6 4"}).addTo(mapObj.current);
      markupDrawRef.current={tool:"line",points:next,tempLayer};
      return;
    }
  };

  // Update a persisted markup after a drag/move
  const updateMarkupGeo=async(id,patch)=>{
    setMapMarkups(prev=>prev.map(m=>m.id===id?{...m,...patch}:m));
    if(!id||id.startsWith("mm_"))return;
    const geo={};
    const next={...mapMarkups.find(m=>m.id===id),...patch};
    if(next.a)geo.a=next.a;if(next.b)geo.b=next.b;
    if(next.center)geo.center=next.center;if(next.radius!=null)geo.radius=next.radius;
    if(next.points)geo.points=next.points;
    if(next.pos)geo.pos=next.pos;
    try{await DB.mapMarkups.update(id,{geo});}catch{}
  };

  // Clear all markups — deletes from DB best-effort then clears local state
  const clearAllMarkups=async()=>{
    const current=mapMarkups.slice();
    setMapMarkups([]);
    for(const m of current){
      if(m.id&&!m.id.startsWith("mm_"))try{await DB.mapMarkups.delete(m.id);}catch{}
    }
  };

  // ── Render mapMarkups (Leaflet) with a centroid drag-handle for move ─
  useEffect(()=>{
    if(status!=="ready"||provider!=="osm"||!mapObj.current||!window.L)return;
    const L=window.L;
    markupLayersRef.current.forEach(l=>{try{l.remove();}catch{}});
    const layers=[];
    mapMarkups.forEach(m=>{
      let shape=null,handleLatLng=null;
      if(m.type==="rect"){
        shape=L.rectangle([[m.a.lat,m.a.lng],[m.b.lat,m.b.lng]],{color:m.color,weight:2,fillOpacity:0.12}).addTo(mapObj.current);
        handleLatLng=[(m.a.lat+m.b.lat)/2,(m.a.lng+m.b.lng)/2];
      }else if(m.type==="circle"){
        shape=L.circle([m.center.lat,m.center.lng],{radius:m.radius,color:m.color,weight:2,fillOpacity:0.12}).addTo(mapObj.current);
        handleLatLng=[m.center.lat,m.center.lng];
      }else if(m.type==="line"){
        shape=L.polyline(m.points.map(p=>[p.lat,p.lng]),{color:m.color,weight:3}).addTo(mapObj.current);
        const cx=m.points.reduce((a,p)=>a+p.lat,0)/m.points.length;
        const cy=m.points.reduce((a,p)=>a+p.lng,0)/m.points.length;
        handleLatLng=[cx,cy];
      }else if(m.type==="text"){
        const safe=(m.text||"").replace(/</g,"&lt;");
        const icon=L.divIcon({className:"",html:`<div style="background:#fff;border:1.5px solid ${m.color};border-radius:6px;padding:2px 8px;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:12px;color:${m.color};white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.15)">${safe}</div>`,iconAnchor:[0,0]});
        shape=L.marker([m.pos.lat,m.pos.lng],{icon,draggable:canEdit}).addTo(mapObj.current);
        if(canEdit)shape.on("dragend",e=>{
          const p=e.target.getLatLng();
          updateMarkupGeo(m.id,{pos:{lat:p.lat,lng:p.lng}});
        });
      }else if(m.type==="stamp"){
        const safe=(m.text||"STAMP").replace(/</g,"&lt;");
        const icon=L.divIcon({className:"",html:`<div style="transform:rotate(-12deg);border:2.5px solid ${m.color};border-radius:4px;padding:2px 10px;font-family:Arial,sans-serif;font-weight:900;font-size:14px;color:${m.color};white-space:nowrap;background:rgba(255,255,255,0.75);letter-spacing:1px">${safe}</div>`,iconAnchor:[0,0]});
        shape=L.marker([m.pos.lat,m.pos.lng],{icon,draggable:canEdit}).addTo(mapObj.current);
        if(canEdit)shape.on("dragend",e=>{
          const p=e.target.getLatLng();
          updateMarkupGeo(m.id,{pos:{lat:p.lat,lng:p.lng}});
        });
      }else if(m.type==="arrow"){
        shape=L.polyline([[m.a.lat,m.a.lng],[m.b.lat,m.b.lng]],{color:m.color,weight:3}).addTo(mapObj.current);
        // Arrowhead as a rotated triangle divIcon anchored at the head
        const dy=m.b.lat-m.a.lat,dx=m.b.lng-m.a.lng;
        const ang=Math.atan2(dy,dx)*180/Math.PI;
        const head=L.marker([m.b.lat,m.b.lng],{icon:L.divIcon({className:"",html:`<div style="width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:14px solid ${m.color};transform:translate(-8px,-14px) rotate(${-ang+90}deg);transform-origin:8px 14px"></div>`,iconSize:[16,14],iconAnchor:[8,14]}),interactive:false}).addTo(mapObj.current);
        layers.push(head);
        handleLatLng=[(m.a.lat+m.b.lat)/2,(m.a.lng+m.b.lng)/2];
      }else if(m.type==="dimension"){
        shape=L.polyline([[m.a.lat,m.a.lng],[m.b.lat,m.b.lng]],{color:m.color,weight:2,dashArray:"3 3"}).addTo(mapObj.current);
        const dist=m.distance!=null?m.distance:haversine(m.a,m.b);
        const mid={lat:(m.a.lat+m.b.lat)/2,lng:(m.a.lng+m.b.lng)/2};
        const lbl=L.marker([mid.lat,mid.lng],{icon:L.divIcon({className:"",html:`<div style="background:${m.color};color:#fff;border-radius:4px;padding:1px 6px;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:11px;white-space:nowrap">${fmtMetres(dist)}</div>`,iconSize:[60,18],iconAnchor:[30,9]}),interactive:false}).addTo(mapObj.current);
        layers.push(lbl);
        handleLatLng=[mid.lat,mid.lng];
      }else if(m.type==="freehand"&&m.points&&m.points.length>1){
        shape=L.polyline(m.points.map(p=>[p.lat,p.lng]),{color:m.color,weight:2.5,opacity:0.9,smoothFactor:1.2}).addTo(mapObj.current);
        const cx=m.points.reduce((a,p)=>a+p.lat,0)/m.points.length;
        const cy=m.points.reduce((a,p)=>a+p.lng,0)/m.points.length;
        handleLatLng=[cx,cy];
      }else if(m.type==="photo"&&m.dataUrl&&m.a&&m.b){
        const n=Math.max(m.a.lat,m.b.lat),s=Math.min(m.a.lat,m.b.lat);
        const e=Math.max(m.a.lng,m.b.lng),w=Math.min(m.a.lng,m.b.lng);
        shape=L.imageOverlay(m.dataUrl,[[s,w],[n,e]],{opacity:0.92,interactive:true}).addTo(mapObj.current);
        handleLatLng=[(n+s)/2,(e+w)/2];
      }
      if(shape)layers.push(shape);
      // Draggable centroid handle for non-marker shapes
      if(canEdit&&handleLatLng&&m.type!=="text"){
        const hIcon=L.divIcon({className:"",html:`<div style="width:14px;height:14px;border-radius:50%;background:${m.color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.2);cursor:move"></div>`,iconSize:[14,14],iconAnchor:[7,7]});
        const handle=L.marker(handleLatLng,{icon:hIcon,draggable:true,zIndexOffset:1000}).addTo(mapObj.current);
        let dragStart=null;
        handle.on("dragstart",e=>{dragStart={lat:e.target.getLatLng().lat,lng:e.target.getLatLng().lng};});
        handle.on("drag",e=>{
          if(!dragStart)return;
          const cur=e.target.getLatLng();
          const dLat=cur.lat-dragStart.lat,dLng=cur.lng-dragStart.lng;
          if(m.type==="rect"&&shape.setBounds){
            shape.setBounds([[m.a.lat+dLat,m.a.lng+dLng],[m.b.lat+dLat,m.b.lng+dLng]]);
          }else if(m.type==="circle"&&shape.setLatLng){
            shape.setLatLng([m.center.lat+dLat,m.center.lng+dLng]);
          }else if(m.type==="line"&&shape.setLatLngs){
            shape.setLatLngs(m.points.map(p=>[p.lat+dLat,p.lng+dLng]));
          }else if((m.type==="arrow"||m.type==="dimension")&&shape.setLatLngs){
            shape.setLatLngs([[m.a.lat+dLat,m.a.lng+dLng],[m.b.lat+dLat,m.b.lng+dLng]]);
          }else if(m.type==="freehand"&&shape.setLatLngs){
            shape.setLatLngs(m.points.map(p=>[p.lat+dLat,p.lng+dLng]));
          }else if(m.type==="photo"&&shape.setBounds){
            const n=Math.max(m.a.lat,m.b.lat),s=Math.min(m.a.lat,m.b.lat);
            const ee=Math.max(m.a.lng,m.b.lng),w=Math.min(m.a.lng,m.b.lng);
            shape.setBounds([[s+dLat,w+dLng],[n+dLat,ee+dLng]]);
          }
        });
        handle.on("dragend",e=>{
          if(!dragStart)return;
          const cur=e.target.getLatLng();
          const dLat=cur.lat-dragStart.lat,dLng=cur.lng-dragStart.lng;
          if(m.type==="rect")updateMarkupGeo(m.id,{a:{lat:m.a.lat+dLat,lng:m.a.lng+dLng},b:{lat:m.b.lat+dLat,lng:m.b.lng+dLng}});
          else if(m.type==="circle")updateMarkupGeo(m.id,{center:{lat:m.center.lat+dLat,lng:m.center.lng+dLng}});
          else if(m.type==="line")updateMarkupGeo(m.id,{points:m.points.map(p=>({lat:p.lat+dLat,lng:p.lng+dLng}))});
          else if(m.type==="arrow"||m.type==="dimension")updateMarkupGeo(m.id,{a:{lat:m.a.lat+dLat,lng:m.a.lng+dLng},b:{lat:m.b.lat+dLat,lng:m.b.lng+dLng}});
          else if(m.type==="freehand")updateMarkupGeo(m.id,{points:m.points.map(p=>({lat:p.lat+dLat,lng:p.lng+dLng}))});
          else if(m.type==="photo")updateMarkupGeo(m.id,{a:{lat:m.a.lat+dLat,lng:m.a.lng+dLng},b:{lat:m.b.lat+dLat,lng:m.b.lng+dLng}});
          dragStart=null;
        });
        layers.push(handle);
      }
    });
    markupLayersRef.current=layers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mapMarkups,status,provider,canEdit]);

  // ── Render mapMarkups (Google Maps) with native draggable shapes ─────
  useEffect(()=>{
    if(status!=="ready"||provider!=="gmaps"||!mapObj.current||!window.google?.maps)return;
    const g=window.google.maps;
    markupLayersRef.current.forEach(l=>{try{l.setMap(null);}catch{}});
    const layers=[];
    mapMarkups.forEach(m=>{
      let obj=null;
      if(m.type==="rect"){
        const bounds={north:Math.max(m.a.lat,m.b.lat),south:Math.min(m.a.lat,m.b.lat),east:Math.max(m.a.lng,m.b.lng),west:Math.min(m.a.lng,m.b.lng)};
        obj=new g.Rectangle({bounds,strokeColor:m.color,strokeWeight:2,fillColor:m.color,fillOpacity:0.12,draggable:canEdit,map:mapObj.current});
        if(canEdit)obj.addListener("dragend",()=>{
          const b=obj.getBounds();const ne=b.getNorthEast(),sw=b.getSouthWest();
          updateMarkupGeo(m.id,{a:{lat:ne.lat(),lng:ne.lng()},b:{lat:sw.lat(),lng:sw.lng()}});
        });
      }else if(m.type==="circle"){
        obj=new g.Circle({center:{lat:m.center.lat,lng:m.center.lng},radius:m.radius,strokeColor:m.color,strokeWeight:2,fillColor:m.color,fillOpacity:0.12,draggable:canEdit,map:mapObj.current});
        if(canEdit)obj.addListener("dragend",()=>{
          const c=obj.getCenter();
          updateMarkupGeo(m.id,{center:{lat:c.lat(),lng:c.lng()}});
        });
      }else if(m.type==="line"){
        obj=new g.Polyline({path:m.points.map(p=>({lat:p.lat,lng:p.lng})),strokeColor:m.color,strokeWeight:3,draggable:canEdit,map:mapObj.current});
        if(canEdit)obj.addListener("dragend",()=>{
          const path=obj.getPath();const pts=[];
          for(let i=0;i<path.getLength();i++){const p=path.getAt(i);pts.push({lat:p.lat(),lng:p.lng()});}
          updateMarkupGeo(m.id,{points:pts});
        });
      }else if(m.type==="text"||m.type==="stamp"){
        const safe=(m.text||"").replace(/</g,"&lt;");
        obj=new g.Marker({
          position:{lat:m.pos.lat,lng:m.pos.lng},
          map:mapObj.current,
          draggable:canEdit,
          label:{text:safe,color:m.color,fontWeight:m.type==="stamp"?"900":"800",fontSize:m.type==="stamp"?"14px":"12px",className:"gmaps-markup-label"},
          icon:{path:g.SymbolPath.CIRCLE,scale:0,fillOpacity:0,strokeOpacity:0},
        });
        if(canEdit)obj.addListener("dragend",e=>{
          updateMarkupGeo(m.id,{pos:{lat:e.latLng.lat(),lng:e.latLng.lng()}});
        });
      }else if(m.type==="arrow"){
        obj=new g.Polyline({
          path:[{lat:m.a.lat,lng:m.a.lng},{lat:m.b.lat,lng:m.b.lng}],
          strokeColor:m.color,strokeWeight:3,
          icons:[{icon:{path:g.SymbolPath.FORWARD_CLOSED_ARROW,scale:4,strokeColor:m.color,fillColor:m.color,fillOpacity:1},offset:"100%"}],
          draggable:canEdit,map:mapObj.current,
        });
        if(canEdit)obj.addListener("dragend",()=>{
          const path=obj.getPath();
          const a={lat:path.getAt(0).lat(),lng:path.getAt(0).lng()};
          const b={lat:path.getAt(1).lat(),lng:path.getAt(1).lng()};
          updateMarkupGeo(m.id,{a,b});
        });
      }else if(m.type==="dimension"){
        const dist=m.distance!=null?m.distance:haversine(m.a,m.b);
        const poly=new g.Polyline({
          path:[{lat:m.a.lat,lng:m.a.lng},{lat:m.b.lat,lng:m.b.lng}],
          strokeColor:m.color,strokeWeight:2,strokeOpacity:0,
          icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:1,scale:3},offset:"0",repeat:"10px"}],
          draggable:canEdit,map:mapObj.current,
        });
        obj=poly;
        const mid={lat:(m.a.lat+m.b.lat)/2,lng:(m.a.lng+m.b.lng)/2};
        const lbl=new g.Marker({
          position:mid,map:mapObj.current,
          label:{text:fmtMetres(dist),color:"#fff",fontWeight:"800",fontSize:"11px"},
          icon:{path:g.SymbolPath.CIRCLE,scale:14,fillColor:m.color,fillOpacity:0.95,strokeColor:"#fff",strokeWeight:1.5},
          clickable:false,
        });
        layers.push(lbl);
        if(canEdit)poly.addListener("dragend",()=>{
          const path=poly.getPath();
          const a={lat:path.getAt(0).lat(),lng:path.getAt(0).lng()};
          const b={lat:path.getAt(1).lat(),lng:path.getAt(1).lng()};
          updateMarkupGeo(m.id,{a,b,distance:haversine(a,b)});
        });
      }else if(m.type==="freehand"&&m.points&&m.points.length>1){
        obj=new g.Polyline({
          path:m.points.map(p=>({lat:p.lat,lng:p.lng})),
          strokeColor:m.color,strokeWeight:2.5,strokeOpacity:0.9,
          draggable:canEdit,map:mapObj.current,
        });
        if(canEdit)obj.addListener("dragend",()=>{
          const path=obj.getPath();const pts=[];
          for(let i=0;i<path.getLength();i++){const p=path.getAt(i);pts.push({lat:p.lat(),lng:p.lng()});}
          updateMarkupGeo(m.id,{points:pts});
        });
      }else if(m.type==="photo"&&m.dataUrl&&m.a&&m.b){
        const mkBounds=(a,b)=>({north:Math.max(a.lat,b.lat),south:Math.min(a.lat,b.lat),east:Math.max(a.lng,b.lng),west:Math.min(a.lng,b.lng)});
        let overlay=new g.GroundOverlay(m.dataUrl,mkBounds(m.a,m.b),{clickable:false,opacity:0.92,map:mapObj.current});
        obj=overlay;
        // GroundOverlay isn't natively draggable — add a draggable handle at
        // the centroid and rebuild the overlay at the new bounds on dragend.
        if(canEdit){
          const mid={lat:(m.a.lat+m.b.lat)/2,lng:(m.a.lng+m.b.lng)/2};
          const handle=new g.Marker({
            position:mid,map:mapObj.current,draggable:true,
            icon:{path:g.SymbolPath.CIRCLE,scale:7,fillColor:m.color,fillOpacity:0.95,strokeColor:"#fff",strokeWeight:2},
            zIndex:9999,title:"Drag to move photo",
          });
          let start=null;
          handle.addListener("dragstart",()=>{start={lat:handle.getPosition().lat(),lng:handle.getPosition().lng()};});
          handle.addListener("dragend",()=>{
            if(!start)return;
            const cur=handle.getPosition();
            const dLat=cur.lat()-start.lat,dLng=cur.lng()-start.lng;
            const na={lat:m.a.lat+dLat,lng:m.a.lng+dLng},nb={lat:m.b.lat+dLat,lng:m.b.lng+dLng};
            overlay.setMap(null);
            overlay=new g.GroundOverlay(m.dataUrl,mkBounds(na,nb),{clickable:false,opacity:0.92,map:mapObj.current});
            updateMarkupGeo(m.id,{a:na,b:nb});
            start=null;
          });
          layers.push(handle);
        }
      }
      if(obj)layers.push(obj);
    });
    markupLayersRef.current=layers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mapMarkups,status,provider,canEdit]);

  // ── OSM / Leaflet path ─────────────────────────────────────────
  useEffect(()=>{
    if(provider!=="osm")return;
    let cancelled=false;
    waitForLeaflet().then(()=>{
      if(cancelled||!mapRef.current||!window.L)return;
      const L=window.L;
      const view=getProjectMapDefault(currentProject?.id);
      const map=L.map(mapRef.current,{zoomControl:true,attributionControl:true}).setView([view.lat,view.lng],view.zoom||17);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
        maxZoom:19,
        crossOrigin:"anonymous", // critical for snap: lets us export tiles to canvas
        attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      mapObj.current=map;
      if(canEdit){
        map.on("click",e=>{
          // Markup-drawing tool takes priority over pin-drop
          const tool=markupToolRef.current;
          if(tool){handleMapMarkupClick(e.latlng,map,L,tool);return;}
          if(!pinModeRef.current)return;
          setPendingPin({lat:e.latlng.lat,lng:e.latlng.lng});
          if(markersRef.current.pending)markersRef.current.pending.remove();
          // Brighter, larger pending pin with pulse so users notice it
          const pendingHtml=`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="15" fill="#ff6b00" opacity="0.3"><animate attributeName="r" values="10;15;10" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="17" cy="17" r="10" fill="#ff6b00" stroke="#fff" stroke-width="3"/><text x="17" y="18" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">+</text></svg>`;
          markersRef.current.pending=L.marker([e.latlng.lat,e.latlng.lng],{icon:L.divIcon({className:"",html:pendingHtml,iconSize:[34,34],iconAnchor:[17,17]}),interactive:false,zIndexOffset:9999}).addTo(map);
        });
        map.on("dblclick",e=>{
          // Finish a multi-click polyline
          if(markupToolRef.current==="line"&&markupDrawRef.current?.points?.length>=2){
            finishPolyline();
          }
        });
      }
      setStatus("ready");
      // Leaflet renders blank if container sized post-mount. Nudge after the
      // first paint, then whenever the container resizes (orientation change,
      // keyboard, Quick Log card appears/disappears, browser chrome hide/show).
      const nudge=()=>{try{map.invalidateSize();}catch{}};
      setTimeout(nudge,60);setTimeout(nudge,400);
      let ro=null;
      if(window.ResizeObserver){ro=new ResizeObserver(nudge);ro.observe(mapRef.current);}
      window.addEventListener("resize",nudge);
      window.addEventListener("orientationchange",nudge);
      map._siteshrimpCleanupResize=()=>{
        try{ro&&ro.disconnect();}catch{}
        window.removeEventListener("resize",nudge);
        window.removeEventListener("orientationchange",nudge);
      };
    }).catch(()=>setStatus("error"));
    return()=>{
      cancelled=true;
      if(mapObj.current){
        try{mapObj.current._siteshrimpCleanupResize&&mapObj.current._siteshrimpCleanupResize();}catch{}
        try{mapObj.current.remove&&mapObj.current.remove();}catch{}
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[provider,currentProject?.id]);

  // Fit the map view to all GPS-pinned entries. Called once after first
  // render so users land on their past pins (rather than an empty saved
  // default), and on demand via the 🎯 FIT button. Does NOT persist — the
  // saved default view (★) is untouched.
  const hasAutoFitRef=useRef(false);
  const fitToAllPins=()=>{
    if(!mapObj.current)return;
    const pts=(defects||[]).filter(d=>typeof d.lat==="number"&&typeof d.lng==="number");
    if(pts.length===0)return;
    if(provider==="gmaps"&&window.google?.maps){
      const g=window.google.maps;
      if(pts.length===1){mapObj.current.setCenter({lat:pts[0].lat,lng:pts[0].lng});mapObj.current.setZoom(18);}
      else{
        const b=new g.LatLngBounds();
        pts.forEach(d=>b.extend({lat:d.lat,lng:d.lng}));
        mapObj.current.fitBounds(b,60);
      }
    }else if(provider==="osm"&&window.L){
      if(pts.length===1)mapObj.current.setView([pts[0].lat,pts[0].lng],18);
      else mapObj.current.fitBounds(pts.map(d=>[d.lat,d.lng]),{padding:[40,40]});
    }
  };

  // ── Render existing defect pins (both providers) ───────────────
  useEffect(()=>{
    if(status!=="ready"||!mapObj.current)return;
    // Clear previous markers AND any active cluster layer (so we can rebuild
    // with current defects — both arrays and clusters).
    markersRef.current.existing.forEach(m=>{if(m.setMap)m.setMap(null);else if(m.remove)m.remove();});
    if(clusterRef.current){
      try{
        if(clusterRef.current.clearMarkers)clusterRef.current.clearMarkers(); // gmaps MarkerClusterer
        if(clusterRef.current.clearLayers)clusterRef.current.clearLayers();   // leaflet cluster group
        if(clusterRef.current.remove&&provider==="osm")clusterRef.current.remove();
      }catch{}
      clusterRef.current=null;
    }
    // Persist a defect's new coords after it's dragged on the map
    const saveDefectMove=async(d,newLat,newLng)=>{
      try{await DB.defects.update(d.id,{lat:newLat,lng:newLng});}catch(e){console.warn("pin move save failed",e);}
    };
    // Permanent-delete a defect's GPS location (unpins from map, entry stays)
    const unpinDefect=async(d)=>{
      if(!confirm("Remove this entry's map pin?\n(The entry itself will stay — only its GPS location is cleared.)"))return;
      try{await DB.defects.update(d.id,{lat:null,lng:null,mapZoom:null});}catch(e){alert("Failed to remove pin: "+e.message);}
    };
    // Shared letter-in-ring SVG for both providers (matches drawing pin style).
    // 28×28 overall; severity letter in the middle.
    const letterInRingSVG=(color,letter,critical)=>{
      const pulse=critical?`<circle cx="14" cy="14" r="13" fill="${color}" opacity="0.4"><animate attributeName="r" values="10;14;10" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0.1;0.6" dur="2s" repeatCount="indefinite"/></circle>`:"";
      return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${pulse}<circle cx="14" cy="14" r="11" fill="rgba(0,0,0,0.55)" stroke="${color}" stroke-width="3"/><circle cx="14" cy="14" r="4" fill="${color}"/><text x="14" y="15" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="900" font-family="'Barlow Condensed',sans-serif" fill="#fff" style="text-shadow:0 1px 2px rgba(0,0,0,0.8)">${letter||""}</text></svg>`;
    };
    // Cluster bubble style — dominant severity colour of the children.
    // Accepts a list of severities and picks the "worst" one so the bubble
    // reflects the most urgent item underneath.
    const SEV_RANK={Critical:4,Major:3,Minor:2,Trivial:1};
    const pickClusterColor=(sevs)=>{
      let top=null,topRank=-1;
      for(const s of sevs){const r=SEV_RANK[s]||0;if(r>topRank){topRank=r;top=s;}}
      return SEV_COLOR[top]||"#ff6b00";
    };
    const clusterBubbleSVG=(count,color)=>`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="${color}" opacity="0.35"/><circle cx="20" cy="20" r="13" fill="${color}" stroke="#fff" stroke-width="2.5"/><text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="900" fill="#fff" font-family="'Barlow Condensed',sans-serif">${count}</text></svg>`;

    if(provider==="gmaps"&&window.google?.maps){
      const g=window.google.maps;
      markersRef.current.existing=mapDefects.map(d=>{
        const color=SEV_COLOR[d.severity]||"#8e8e93";
        const letter=d.severity?d.severity[0]:"";
        const critical=d.severity==="Critical"&&d.status==="Open";
        const url="data:image/svg+xml;utf8,"+encodeURIComponent(letterInRingSVG(color,letter,critical));
        const m=new g.Marker({
          position:{lat:d.lat,lng:d.lng},
          // NOTE: no `map:` here — markers are owned by the clusterer below
          icon:{url,scaledSize:new g.Size(28,28),anchor:new g.Point(14,14)},
          title:canEdit?(d.title||"Entry")+" — drag to move":(d.title||"Entry"),
          draggable:canEdit,
        });
        m._defect=d;
        const safeTitle=(d.title||"Entry").replace(/</g,"&lt;");
        const iw=new g.InfoWindow({content:`<div style="font-family:'Barlow Condensed',sans-serif;padding:4px 6px;min-width:140px"><div style="font-weight:800;font-size:13px;color:#1a1a1a">${safeTitle}</div><div style="font-size:11px;color:${color};font-weight:700;margin-top:2px">${d.severity||""}${d.status?" · "+d.status:""}</div>${canEdit?`<div style="font-size:10px;color:rgba(0,0,0,0.45);margin-top:4px">Drag to move</div><button id="mm-del-${d.id}" style="margin-top:6px;width:100%;background:rgba(255,59,48,0.12);border:1px solid rgba(255,59,48,0.3);border-radius:6px;padding:4px 8px;color:#cc0000;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;cursor:pointer">REMOVE PIN</button>`:""}</div>`});
        m.addListener("click",()=>{
          iw.open({anchor:m,map:mapObj.current});
          if(canEdit){setTimeout(()=>{const b=document.getElementById("mm-del-"+d.id);if(b)b.onclick=()=>{iw.close();unpinDefect(d);};},30);}
        });
        if(canEdit)m.addListener("dragend",e=>saveDefectMove(d,e.latLng.lat(),e.latLng.lng()));
        return m;
      });
      // Wrap markers in a clusterer so overlapping pins collapse into a
      // numbered bubble. Falls back to plain markers if the lib failed to load.
      const MC=window.markerClusterer;
      if(MC&&MC.MarkerClusterer){
        clusterRef.current=new MC.MarkerClusterer({
          map:mapObj.current,
          markers:markersRef.current.existing,
          renderer:{render:({count,markers})=>{
            const color=pickClusterColor(markers.map(mk=>mk._defect?.severity));
            return new g.Marker({
              icon:{url:"data:image/svg+xml;utf8,"+encodeURIComponent(clusterBubbleSVG(count,color)),scaledSize:new g.Size(40,40),anchor:new g.Point(20,20)},
              label:"",zIndex:1000+count,
            });
          }},
        });
      }else{
        markersRef.current.existing.forEach(m=>m.setMap(mapObj.current));
      }
    }else if(provider==="osm"&&window.L){
      const L=window.L;
      markersRef.current.existing=mapDefects.map(d=>{
        const color=SEV_COLOR[d.severity]||"#8e8e93";
        const letter=d.severity?d.severity[0]:"";
        const critical=d.severity==="Critical"&&d.status==="Open";
        const icon=L.divIcon({className:"",html:letterInRingSVG(color,letter,critical),iconSize:[28,28],iconAnchor:[14,14]});
        const m=L.marker([d.lat,d.lng],{icon,draggable:canEdit,title:canEdit?(d.title||"Entry")+" — drag to move":(d.title||"Entry")});
        m._defect=d;
        const safeTitle=(d.title||"Entry").replace(/</g,"&lt;");
        m.bindPopup(`<div style="font-family:'Barlow Condensed',sans-serif;padding:2px 4px;min-width:140px"><div style="font-weight:800;font-size:13px;color:#1a1a1a">${safeTitle}</div><div style="font-size:11px;color:${color};font-weight:700;margin-top:2px">${d.severity||""}${d.status?" · "+d.status:""}</div>${canEdit?`<div style="font-size:10px;color:rgba(0,0,0,0.45);margin-top:4px">Drag to move</div><button id="mm-del-${d.id}" style="margin-top:6px;width:100%;background:rgba(255,59,48,0.12);border:1px solid rgba(255,59,48,0.3);border-radius:6px;padding:4px 8px;color:#cc0000;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;cursor:pointer">REMOVE PIN</button>`:""}</div>`);
        if(canEdit){
          m.on("popupopen",()=>{setTimeout(()=>{const b=document.getElementById("mm-del-"+d.id);if(b)b.onclick=()=>{m.closePopup();unpinDefect(d);};},30);});
          m.on("dragend",e=>{const p=e.target.getLatLng();saveDefectMove(d,p.lat,p.lng);});
        }
        return m;
      });
      // Group into a MarkerClusterGroup. Custom cluster icon reflects the
      // severity mix so users spot hotspots at a glance.
      if(L.markerClusterGroup){
        const group=L.markerClusterGroup({
          showCoverageOnHover:false,
          spiderfyOnMaxZoom:true,
          maxClusterRadius:40,
          iconCreateFunction:(cluster)=>{
            const children=cluster.getAllChildMarkers();
            const sevs=children.map(c=>c._defect?.severity);
            const color=pickClusterColor(sevs);
            return L.divIcon({className:"",html:clusterBubbleSVG(children.length,color),iconSize:[40,40],iconAnchor:[20,20]});
          },
        });
        markersRef.current.existing.forEach(m=>group.addLayer(m));
        group.addTo(mapObj.current);
        clusterRef.current=group;
      }else{
        markersRef.current.existing.forEach(m=>m.addTo(mapObj.current));
      }
    }
    // First-render only: frame every existing pin so users see where past
    // entries were added instead of staring at the saved default.
    if(!hasAutoFitRef.current&&mapDefects.length>0){
      hasAutoFitRef.current=true;
      setTimeout(fitToAllPins,120);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[status,defects,provider]);
  // Reset the auto-fit guard when switching projects or providers.
  useEffect(()=>{hasAutoFitRef.current=false;},[currentProject?.id,provider]);

  // Snap the current map view and save as a drawing. User then pins defects
  // using the drawing pin system (multi-pin, drag, markup, heatmap — parity).
  const[snapping,setSnapping]=useState(false);
  const[savedToast,setSavedToast]=useState(false);
  const quickLogRef=useRef(null);
  // Scroll the Quick Log card into view the moment it appears, so narrow
  // phones don't hide it below the fold and leave users wondering why the
  // next map tap only "moves" the pin.
  useEffect(()=>{
    if(pendingPin&&quickLogRef.current){
      try{quickLogRef.current.scrollIntoView({behavior:"smooth",block:"nearest"});}catch{}
    }
  },[pendingPin]);
  // Capture the live map directly from the DOM — works even on tile servers
  // that don't support CORS on their static-map endpoint, since we draw the
  // already-rendered tile <img> elements (loaded with crossOrigin:anonymous).
  const snapFromLeafletDOM=()=>{
    const map=mapObj.current;
    const size=map.getSize();
    const cnv=document.createElement("canvas");
    cnv.width=size.x;cnv.height=size.y;
    const ctx=cnv.getContext("2d");
    ctx.fillStyle="#e5e3dc";ctx.fillRect(0,0,size.x,size.y);
    const mapRect=map.getContainer().getBoundingClientRect();
    const tiles=map.getContainer().querySelectorAll(".leaflet-tile");
    for(const tile of tiles){
      if(!tile.src||!tile.complete||tile.naturalWidth===0)continue;
      const r=tile.getBoundingClientRect();
      try{ctx.drawImage(tile,r.left-mapRect.left,r.top-mapRect.top,r.width,r.height);}
      catch(e){throw new Error("Tiles tainted (not loaded with CORS). Reload the map and try again.");}
    }
    return new Promise(res=>cnv.toBlob(res,"image/jpeg",0.88));
  };

  const snapFromStaticUrl=async()=>{
    let lat,lng,zoom;
    if(provider==="gmaps"){const c=mapObj.current.getCenter();lat=c.lat();lng=c.lng();zoom=mapObj.current.getZoom();}
    else{const c=mapObj.current.getCenter();lat=c.lat;lng=c.lng;zoom=mapObj.current.getZoom();}
    const url=staticMapUrl(provider,lat,lng,zoom,"1024x1024");
    if(!url)throw new Error("No static map URL available for this provider.");
    const img=await new Promise((resolve,reject)=>{
      const i=new Image();i.crossOrigin="anonymous";
      i.onload=()=>resolve(i);i.onerror=()=>reject(new Error("tile server blocked cross-origin capture"));
      i.src=url;
    });
    const cnv=document.createElement("canvas");
    cnv.width=img.width;cnv.height=img.height;
    cnv.getContext("2d").drawImage(img,0,0);
    return new Promise(res=>cnv.toBlob(res,"image/jpeg",0.88));
  };

  const snapAsDrawing=async()=>{
    if(!mapObj.current||!company?.companyId||!currentProject?.id)return;
    setSnapping(true);
    try{
      // Current view metadata for the drawing name
      let lat,lng,zoom;
      if(provider==="gmaps"){const c=mapObj.current.getCenter();lat=c.lat();lng=c.lng();zoom=mapObj.current.getZoom();}
      else{const c=mapObj.current.getCenter();lat=c.lat;lng=c.lng;zoom=mapObj.current.getZoom();}
      // OSM: capture from the DOM (tiles already loaded with crossOrigin:anonymous).
      // gmaps: static-map URL (Google sends CORS headers for Static Maps with valid keys).
      let blob;
      try{blob=provider==="osm"?await snapFromLeafletDOM():await snapFromStaticUrl();}
      catch(e){
        // One-shot fallback: if DOM capture fails (e.g. tiles re-rendered during
        // canvas write), try the static URL instead.
        blob=await snapFromStaticUrl();
      }
      if(!blob)throw new Error("Could not export map image.");
      const stamp=new Date().toISOString().slice(0,10);
      const label=`Map ${stamp} — ${lat.toFixed(4)}, ${lng.toFixed(4)} @ z${zoom}`;
      const file=new File([blob],`${label}.jpg`,{type:"image/jpeg"});
      const rec=await DB.drawings.createWithFile({
        companyId:company.companyId,projectId:currentProject.id,
        name:label,uploadedBy:member?.name||"",uploadedAt:new Date().toISOString(),
      },"file",file,file.name);
      if(onSnapped)onSnapped(rec);
      else alert("✓ Saved as drawing: "+label);
    }catch(e){
      alert("Snap failed: "+(e.message||e));
    }
    setSnapping(false);
  };

  const saveDefault=()=>{
    if(!mapObj.current||!currentProject?.id)return;
    let lat,lng,zoom;
    if(provider==="gmaps"){
      const c=mapObj.current.getCenter();lat=c.lat();lng=c.lng();zoom=mapObj.current.getZoom();
    }else{
      const c=mapObj.current.getCenter();lat=c.lat;lng=c.lng;zoom=mapObj.current.getZoom();
    }
    setProjectMapDefault(currentProject.id,{lat,lng,zoom});
    setSavedDefault(true);setTimeout(()=>setSavedDefault(false),2200);
  };

  const cancelPending=()=>{
    if(markersRef.current.pending){
      if(markersRef.current.pending.setMap)markersRef.current.pending.setMap(null);
      else if(markersRef.current.pending.remove)markersRef.current.pending.remove();
      markersRef.current.pending=null;
    }
    setPendingPin(null);setQTitle("");setQSev("Minor");
  };

  // OSM search via Nominatim
  const searchOsm=async()=>{
    if(provider!=="osm"||!searchRef.current||!mapObj.current)return;
    const q=searchRef.current.value;
    if(!q||!q.trim())return;
    setSearching(true);
    const hit=await geocodeNominatim(q);
    setSearching(false);
    if(!hit){alert("Location not found.");return;}
    mapObj.current.setView([hit.lat,hit.lng],17);
  };

  const savePin=async(addAnother)=>{
    if(!pendingPin||!qTitle.trim()||!onSaveEntry)return;
    setSaving(true);
    try{
      const zoom=mapObj.current?.getZoom();
      // Full shape used by LogDefect — PocketBase complains "Cannot be blank"
      // on missing entryType / projectId / projectName / createdAt, etc.
      await onSaveEntry({
        title:qTitle.trim(),
        severity:qSev,
        status:"Open",
        entryType:"Defect",
        description:`Pinned on map at ${pendingPin.lat.toFixed(5)}, ${pendingPin.lng.toFixed(5)}`,
        location:`Map: ${pendingPin.lat.toFixed(5)}, ${pendingPin.lng.toFixed(5)}`,
        level:"",zone:"",roomArea:"",gridRef:"",
        component:"",trade:"",
        assignee:"",
        dueDate:"",duration:"",
        costImpact:"",costResponsible:"",costAmount:"",costRemarks:"",
        photo:null,extraPhotos:[],
        projectId:currentProject?.id||"default",
        projectName:currentProject?.name||"",
        loggedBy:member?.name||"",
        loggedByRole:member?.role||"",
        createdAt:DB.serverTimestamp(),
        updatedAt:DB.serverTimestamp(),
        comments:[],
        lat:pendingPin.lat,
        lng:pendingPin.lng,
        mapZoom:zoom||17,
      });
      cancelPending();
      // Always keep pin mode on after a save so the next map tap drops another
      setPinMode(true);
      // Brief success toast so users know the pin was captured even if the
      // severity-coloured marker doesn't appear yet (subscription round-trip).
      setSavedToast(true);setTimeout(()=>setSavedToast(false),2200);
    }catch(e){
      alert("Failed to save: "+(e.message||e));
    }
    setSaving(false);
  };

  if(status==="error"){
    return <div style={{padding:30,textAlign:"center",color:"#ff3b30",fontSize:13}}>{t("maps.sdk_failed")}</div>;
  }

  const providerLabel=provider==="gmaps"?"Google Maps":"OpenStreetMap";

  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <input ref={photoInputRef} type="file" accept="image/*" onChange={onPickMarkupPhoto} style={{display:"none"}}/>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <form onSubmit={e=>{e.preventDefault();if(provider==="osm")searchOsm();}} style={{flex:1,display:"flex",gap:6}}>
          <input ref={searchRef} type="text" placeholder={t("maps.search_address")||"Search address or location..."} style={{flex:1,padding:"10px 12px",fontSize:13,borderRadius:10,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",boxSizing:"border-box"}}/>
          {provider==="osm"&&<button type="submit" disabled={searching} style={{padding:"10px 14px",borderRadius:10,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",color:"rgba(0,0,0,0.7)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:searching?"wait":"pointer"}}>{searching?"…":"🔍"}</button>}
        </form>
        {canEdit&&<button onClick={saveDefault} title={t("maps.save_default_view")} style={{padding:"10px 12px",borderRadius:10,border:"1px solid rgba(0,0,0,0.14)",background:savedDefault?"rgba(48,209,88,0.15)":"#fff",color:savedDefault?"#30d158":"rgba(0,0,0,0.7)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>{savedDefault?"✓":"★"}</button>}
      </div>
      {/* Toolbar: ADD PIN / MARKUP / LIST — mirrors Drawing viewer */}
      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
        {canEdit&&(
          <button onClick={()=>{setPinMode(v=>!v);if(markupTool)setMarkupTool(null);}} style={{padding:"8px 12px",borderRadius:10,border:"1px solid "+(pinMode&&!markupTool?"rgba(255,107,0,0.4)":"rgba(0,0,0,0.12)"),background:pinMode&&!markupTool?"rgba(255,107,0,0.12)":"#fff",color:pinMode&&!markupTool?"#ff6b00":"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            📌 ADD PIN {pinMode&&!markupTool?"· ON":""}
          </button>
        )}
        {canEdit&&(
          <button onClick={()=>{
            // Toggle markup: turning OFF restores pin-drop (the default).
            if(markupTool){setMarkupTool(null);setPinMode(true);}
            else{setMarkupTool("rect");setPinMode(false);}
          }} style={{padding:"8px 12px",borderRadius:10,border:"1px solid "+(markupTool?"rgba(88,86,214,0.4)":"rgba(0,0,0,0.12)"),background:markupTool?"rgba(88,86,214,0.12)":"#fff",color:markupTool?"#5856d6":"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            ✏ MARKUP {markupTool?"· ON":""}
          </button>
        )}
        <button onClick={()=>setShowList(v=>!v)} style={{padding:"8px 12px",borderRadius:10,border:"1px solid "+(showList?"rgba(52,170,220,0.4)":"rgba(0,0,0,0.12)"),background:showList?"rgba(52,170,220,0.12)":"#fff",color:showList?"#2b8bb8":"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
          📋 LIST ({mapDefects.length})
        </button>
        {mapDefects.length>0&&(
          <button onClick={fitToAllPins} title="Recenter map to show every pinned entry in this project" style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,107,0,0.3)",background:"#fff",color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            🎯 FIT
          </button>
        )}
        {canEdit&&(
          <button onClick={snapAsDrawing} disabled={snapping} title="Capture current map view as a drawing (pin like a floor plan)" style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(48,209,88,0.4)",background:snapping?"rgba(48,209,88,0.25)":"rgba(48,209,88,0.12)",color:"#1a7a35",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:snapping?"wait":"pointer",display:"flex",alignItems:"center",gap:6}}>
            {snapping?"…":"📸"} SNAP
          </button>
        )}
        <span style={{marginLeft:"auto",fontSize:10,background:"rgba(0,0,0,0.05)",padding:"3px 8px",borderRadius:8,color:"rgba(0,0,0,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{providerLabel}</span>
      </div>
      {savedToast&&(
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"rgba(48,209,88,0.14)",border:"1px solid rgba(48,209,88,0.4)",borderRadius:10,fontSize:12,color:"#1a7a35",animation:"fadeIn 0.2s ease"}}>
          <span style={{fontSize:14}}>✓</span>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800}}>Pin saved — tap the map to add another.</span>
        </div>
      )}
      {canEdit&&pinMode&&!pendingPin&&!markupTool&&!savedToast&&(
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.25)",borderRadius:10,fontSize:12,color:"#b34800"}}>
          <span style={{fontSize:14}}>📍</span>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("maps.drop_pin_hint")||"Tap the map to drop a pin and create an entry"}</span>
        </div>
      )}
      {canEdit&&!pinMode&&!markupTool&&(
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:10,fontSize:12,color:"rgba(0,0,0,0.55)"}}>
          <span style={{fontSize:14}}>ℹ️</span>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>Tap <b style={{color:"#ff6b00"}}>📌 ADD PIN</b> to drop pins, or <b style={{color:"#5856d6"}}>✏ MARKUP</b> to draw on the map.</span>
        </div>
      )}
      {canEdit&&markupTool&&(
        <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:6,padding:"8px 10px",background:"rgba(88,86,214,0.08)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:10}}>
          <button onClick={()=>{markupDrawRef.current=null;setMarkupTool(null);setPinMode(true);}} title="Exit markup mode" style={{padding:"8px 14px",borderRadius:8,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",boxShadow:"0 1px 4px rgba(88,86,214,0.35)"}}>✓ DONE</button>
          {[
            {id:"rect",label:"▭ ZONE"},
            {id:"circle",label:"◯ RADIUS"},
            {id:"line",label:"⇢ PATH"},
            {id:"arrow",label:"→ ARROW"},
            {id:"dimension",label:"↔ DIMENSION"},
            {id:"stamp",label:"◈ STAMP"},
            {id:"text",label:"T LABEL"},
            {id:"freehand",label:"✎ FREEHAND"},
            {id:"photo",label:"🖼 PHOTO"},
          ].map(tool=>(
            <button key={tool.id} onClick={()=>{markupDrawRef.current=null;setMarkupTool(tool.id);}} style={{padding:"6px 10px",borderRadius:8,border:"1px solid "+(markupTool===tool.id?"#5856d6":"rgba(88,86,214,0.25)"),background:markupTool===tool.id?"#5856d6":"#fff",color:markupTool===tool.id?"#fff":"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>{tool.label}</button>
          ))}
          <span style={{fontSize:11,color:"rgba(88,86,214,0.75)",marginLeft:4,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>
            {markupTool==="rect"?"Click two opposite corners":markupTool==="circle"?"Click centre, then edge":markupTool==="line"?"Click points · double-click to finish":markupTool==="arrow"?"Click tail, then head":markupTool==="dimension"?"Click start, then end — distance auto-labelled":markupTool==="stamp"?"Click where the stamp goes":markupTool==="text"?"Click where the label goes":markupTool==="freehand"?"Click-and-drag on the map to draw":markupTool==="photo"?"Pick an image, then click the map to place it":""}
          </span>
          <span style={{marginLeft:"auto",display:"flex",gap:6}}>
            {mapMarkups.length>0&&<button onClick={()=>{if(confirm("Clear all map markup?"))clearAllMarkups();}} style={{padding:"6px 10px",borderRadius:8,border:"1px solid rgba(255,59,48,0.3)",background:"#fff",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>CLEAR ALL ({mapMarkups.length})</button>}
            <button onClick={()=>{markupDrawRef.current=null;setMarkupTool(null);setPinMode(true);}} style={{padding:"6px 10px",borderRadius:8,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",color:"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>DONE</button>
          </span>
        </div>
      )}
      {showList&&(
        <div style={{background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,padding:8,maxHeight:"30vh",overflowY:"auto"}}>
          {mapDefects.length===0?(
            <div style={{padding:20,textAlign:"center",color:"rgba(0,0,0,0.4)",fontSize:12}}>No map-pinned entries yet.</div>
          ):mapDefects.map(d=>(
            <button key={d.id} onClick={()=>{if(!mapObj.current)return;if(provider==="gmaps"){mapObj.current.setCenter({lat:d.lat,lng:d.lng});mapObj.current.setZoom(19);}else{mapObj.current.setView([d.lat,d.lng],19);}setShowList(false);}} style={{display:"flex",width:"100%",alignItems:"center",gap:10,padding:"8px 10px",marginBottom:4,borderRadius:8,border:"1px solid rgba(0,0,0,0.06)",background:"#fafafa",cursor:"pointer",textAlign:"left"}}>
              <span style={{width:10,height:10,borderRadius:"50%",background:SEV_COLOR[d.severity]||"#8e8e93",flexShrink:0}}/>
              <span style={{flex:1,fontSize:12,fontWeight:700,color:"#1a1a1a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.title||"Entry"}</span>
              <span style={{fontSize:10,color:"rgba(0,0,0,0.5)",fontFamily:"monospace"}}>{d.lat.toFixed(4)},{d.lng.toFixed(4)}</span>
            </button>
          ))}
        </div>
      )}
      <div ref={mapRef} style={{width:"100%",height:"min(55dvh,480px)",minHeight:260,borderRadius:12,border:"1px solid rgba(0,0,0,0.12)",background:"#e5e3dc",overscrollBehavior:"contain",touchAction:"pan-x pan-y"}}/>
      {pendingPin&&<div ref={quickLogRef} style={{padding:14,background:"#fff",border:"2px solid rgba(255,107,0,0.4)",borderRadius:12,display:"flex",flexDirection:"column",gap:10,boxShadow:"0 2px 12px rgba(255,107,0,0.15)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
          <span style={{width:22,height:22,borderRadius:"50%",background:"#ff6b00",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,flexShrink:0}}>2</span>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#1a1a1a"}}>Give this pin a title & severity</span>
        </div>
        <div style={{fontSize:11,color:"rgba(0,0,0,0.45)",marginLeft:30}}>Fill in below, then SAVE — or tap Cancel to reposition the pin.</div>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,background:"rgba(0,0,0,0.04)",padding:"6px 10px",borderRadius:8}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"rgba(0,0,0,0.55)"}}>📍 {t("maps.lat_lng")}:</span>
          <span style={{fontFamily:"monospace",fontSize:11,color:"rgba(0,0,0,0.7)"}}>{pendingPin.lat.toFixed(6)}, {pendingPin.lng.toFixed(6)}</span>
        </div>
        <input type="text" value={qTitle} onChange={e=>setQTitle(e.target.value)} placeholder={t("fields.title_placeholder")} autoFocus style={{padding:"11px 12px",fontSize:14,borderRadius:8,border:"1.5px solid "+(qTitle.trim()?"rgba(48,209,88,0.4)":"rgba(0,0,0,0.18)"),background:"#fff",boxSizing:"border-box"}}/>
        <select value={qSev} onChange={e=>setQSev(e.target.value)} style={{padding:"11px 12px",fontSize:13,borderRadius:8,border:"1.5px solid rgba(0,0,0,0.18)",background:"#fff"}}>
          {["Critical","Major","Minor","Observation"].map(s=>(<option key={s} value={s}>{tOpt(s)} — {s==="Critical"?"immediate action":s==="Major"?"fix soon":s==="Minor"?"schedule repair":"noted for reference"}</option>))}
        </select>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={cancelPending} disabled={saving} style={{flex:"1 1 80px",padding:"11px 10px",borderRadius:8,border:"1px solid rgba(0,0,0,0.14)",background:"#fff",color:"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:saving?"not-allowed":"pointer"}}>{t("actions.cancel")}</button>
          <button onClick={()=>savePin(true)} disabled={saving||!qTitle.trim()} title="Save this pin, keep ADD PIN on, tap next location" style={{flex:"1 1 130px",padding:"11px 10px",borderRadius:8,border:"1px solid "+(qTitle.trim()&&!saving?"rgba(255,107,0,0.4)":"rgba(0,0,0,0.1)"),background:qTitle.trim()&&!saving?"rgba(255,107,0,0.1)":"rgba(0,0,0,0.03)",color:qTitle.trim()&&!saving?"#ff6b00":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:qTitle.trim()&&!saving?"pointer":"not-allowed"}}>+ SAVE & ADD ANOTHER</button>
          <button onClick={()=>savePin(false)} disabled={saving||!qTitle.trim()} style={{flex:"2 1 120px",padding:"11px 12px",borderRadius:8,border:"none",background:qTitle.trim()&&!saving?"#ff6b00":"rgba(0,0,0,0.1)",color:qTitle.trim()&&!saving?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:qTitle.trim()&&!saving?"pointer":"not-allowed"}}>{saving?t("messages.saving"):"✓ SAVE PIN"}</button>
        </div>
      </div>}
    </div>
  );
}

// ── Drawings & Floor Plan Pins ────────────────────────────────────
function DrawingsPanel({onClose,company,currentProject,member,defects,onSaveEntry,initialCompare,embedded}){
  const[drawings,setDrawings]=useState([]);const[loading,setLoading]=useState(true);
  const[viewing,setViewing]=useState(null);
  const[uploading,setUploading]=useState(false);
  const[allPins,setAllPins]=useState([]);
  const[subMode,setSubMode]=useState("drawing"); // "drawing" | "map" | "compare"
  const[showCompare,setShowCompare]=useState(false);
  const[compareBaseId,setCompareBaseId]=useState("");
  const[compareTargetId,setCompareTargetId]=useState("");
  const[comparing,setComparing]=useState(false);
  const[compareError,setCompareError]=useState("");
  const[compareRes,setCompareRes]=useState(null);
  const[compareAiBusy,setCompareAiBusy]=useState(false);
  const[compareAiError,setCompareAiError]=useState("");
  const[compareAiReport,setCompareAiReport]=useState("");
  const[compareAiLocked,setCompareAiLocked]=useState(false);
  const[compareAiApprovedBy,setCompareAiApprovedBy]=useState("");
  const[compareAiApprovedAt,setCompareAiApprovedAt]=useState(null);
  const[compareAuditLog,setCompareAuditLog]=useState([]);
  const[showUnlockPrompt,setShowUnlockPrompt]=useState(false);
  const[unlockReason,setUnlockReason]=useState("");
  const[comparePreviewLoading,setComparePreviewLoading]=useState(false);
  const[compareZoom,setCompareZoom]=useState(1);
  const[comparePan,setComparePan]=useState({x:0,y:0});
  const[compareHighlight,setCompareHighlight]=useState(null);
  const[editingDiffItem,setEditingDiffItem]=useState(null);
  const[diffEdits,setDiffEdits]=useState({});
  const[aiRenameBusy,setAiRenameBusy]=useState(false);
  const comparePanStart=useRef(null);
  const comparePinchDist=useRef(null);
  const compareOverlayCanvasRef=useRef();
  const[compareMarkupTool,setCompareMarkupTool]=useState("freehand");
  const[compareMarkupLineStyle,setCompareMarkupLineStyle]=useState("solid");
  const[compareMarkupColor,setCompareMarkupColor]=useState("#ff3b30");
  const[compareMarkupStrokes,setCompareMarkupStrokes]=useState([]);
  const[compareMarkupCurrent,setCompareMarkupCurrent]=useState(null);
  const[compareSelectedIdx,setCompareSelectedIdx]=useState(null);
  const[compareRedoStack,setCompareRedoStack]=useState([]);
  const[cmpPolylinePoints,setCmpPolylinePoints]=useState([]);
  const[cmpPolylineClosed,setCmpPolylineClosed]=useState(false);
  const[cmpStampType,setCmpStampType]=useState("APPROVED");
  const[showCmpStampMenu,setShowCmpStampMenu]=useState(false);
  const[cmpCalloutStroke,setCmpCalloutStroke]=useState(null);
  const[cmpCalloutText,setCmpCalloutText]=useState("");
  const CMP_STAMP_PRESETS=["APPROVED","REJECTED","REVIEWED","HOLD","FOR CONSTRUCTION","PRELIMINARY","DRAFT","SUPERSEDED","NOT FOR CONSTRUCTION"];
  const addCompareStroke=(s)=>{setCompareMarkupStrokes(prev=>[...prev,s]);setCompareRedoStack([]);};
  const compareDragRef=useRef(null);
  const[comparePendingPhoto,setComparePendingPhoto]=useState(null);
  const[comparePhotoPlaceRect,setComparePhotoPlaceRect]=useState(null);
  const[compareTextSize,setCompareTextSize]=useState(2.4);
  const[compareTextAlign,setCompareTextAlign]=useState("left");
  const[compareTextValign,setCompareTextValign]=useState("bottom");
  const[showAlignMenu,setShowAlignMenu]=useState(false);const alignMenuTimer=useRef(null);
  const[showCompareColorMenu,setShowCompareColorMenu]=useState(false);const compareColorTimer=useRef(null);
  const[showCompareSizeMenu,setShowCompareSizeMenu]=useState(false);const compareSizeTimer=useRef(null);
  const[compareTextPoint,setCompareTextPoint]=useState(null);
  const[compareTextValue,setCompareTextValue]=useState("");
  const[comparePendingDim,setComparePendingDim]=useState(null);
  const[compareDimLabel,setCompareDimLabel]=useState("");
  const[savedComparisons,setSavedComparisons]=useState(()=>getSavedComparisons(currentProject?.id||""));
  const[viewingSaved,setViewingSaved]=useState(null);
  const fileRef=useRef();
  const convertRef=useRef();
  const[converting,setConverting]=useState(false);
  // {label, pct (0..100), stage, totalFiles, fileIdx}  — null when idle.
  const[convertProgress,setConvertProgress]=useState(null);
  // Flipped by the Stop button. Checked between files so the batch loop can
  // bail early. The in-flight file still finishes because ImageTracer /
  // svg2pdf are not interruptible, but every file after it is skipped.
  const convertCancelRef=useRef(false);
  // Batch compare state
  const[showBatchCompare,setShowBatchCompare]=useState(false);
  const[showDnMenu,setShowDnMenu]=useState(false);const dnMenuTimer=useRef(null);
  const[showDiffMenu,setShowDiffMenu]=useState(false);const diffMenuTimer=useRef(null);
  const[batchLabelA,setBatchLabelA]=useState("SET A");
  const[batchLabelB,setBatchLabelB]=useState("SET B");
  const[batchSetAFiles,setBatchSetAFiles]=useState([]);
  const[batchSetBFiles,setBatchSetBFiles]=useState([]);
  const[batchMatches,setBatchMatches]=useState([]);// [{fileA,fileB,similarity}]
  const[batchUnmatchedA,setBatchUnmatchedA]=useState([]);
  const[batchUnmatchedB,setBatchUnmatchedB]=useState([]);
  const[batchRunning,setBatchRunning]=useState(false);
  const[batchResults,setBatchResults]=useState([]);// [{nameA,nameB,added,removed,status}]
  const[batchProgress,setBatchProgress]=useState({current:0,total:0});
  const batchSetARef=useRef();
  const batchSetBRef=useRef();
  const compareBoardRef=useRef();
  const compareBaseCanvasRef=useRef();
  const compareTargetCanvasRef=useRef();
  const canUpload=["Admin","Manager"].includes(member?.role);
  const canApproveAi=["Admin","Manager"].includes(member?.role);
  const aiReady=isAiConfigured();
  const pdfDrawings=drawings.filter(d=>/\.pdf$/i.test(d.file||""));

  // Load drawings for current project
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    setLoading(true);
    DB.drawings.list(`companyId="${company.companyId}" && projectId="${currentProject.id}"`).then(items=>{
      setDrawings(items);setLoading(false);
      // Auto-open compare if launched from dashboard shortcut
      if(initialCompare){
        const pdfs=items.filter(d=>/\.pdf$/i.test(d.file||""));
        if(pdfs.length>=2){
          setCompareBaseId(pdfs[0].id);
          setCompareTargetId(pdfs[1].id);
          setShowCompare(true);
        }
      }
    }).catch(()=>setLoading(false));
  },[company?.companyId,currentProject?.id]);

  // Real-time pin subscription for all drawings
  useEffect(()=>{
    if(!drawings.length)return;
    const unsubs=drawings.map(d=>DB.pins.subscribe(`drawingId="${d.id}"`,items=>{
      setAllPins(prev=>{
        const other=prev.filter(p=>p.drawingId!==d.id);
        return[...other,...items];
      });
    }));
    return()=>unsubs.forEach(u=>u());
  },[drawings]);

  const uploadDrawing=async e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    setUploading(true);
    try{
      const rec=await DB.drawings.createWithFile({
        companyId:company.companyId,
        projectId:currentProject.id,
        name:file.name.replace(/\.[^.]+$/,""),
        uploadedBy:member?.name||"",
        uploadedAt:new Date().toISOString()
      },"file",file,file.name);
      setDrawings(prev=>[rec,...prev]);
    }catch(err){alert("Upload failed: "+err.message);}
    setUploading(false);
    if(fileRef.current)fileRef.current.value="";
  };

  // Raster-to-vector: trace one JPG/PNG sketch into a single-page vector PDF.
  // Uses ImageTracer (threshold → SVG paths) then svg2pdf to draw the SVG
  // into a jsPDF page as real vector strokes — output is a true vector PDF
  // usable as a Compare base drawing, not a raster wrapped in PDF.
  // Stage-weighted progress estimate for one file. The long stage is
  // `trace` (~70% of the budget for any realistic image), the rest are
  // order-of-magnitude faster.
  const STAGE_WEIGHTS={read:5,decode:5,preprocess:10,trace:65,svg:5,pdf:5,upload:5};
  const traceOneToPdfBlob=(file,onStage)=>new Promise((resolve,reject)=>{
    const report=(stage,within=0)=>{if(onStage)onStage(stage,within);};
    if(!window.ImageTracer)return reject(new Error("ImageTracer not loaded — refresh the app."));
    if(!window.jspdf||!window.svg2pdf)return reject(new Error("PDF libs not loaded — refresh the app."));
    report("read",0);
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("Failed to read file."));
    reader.onload=()=>{
      report("decode",0);
      const img=new Image();
      img.onerror=()=>reject(new Error("Failed to decode image."));
      img.onload=()=>{
        report("preprocess",0);
        // Downscale very large images so tracing stays responsive. Cap is
        // tighter than before (1200 instead of 1600) — on a 9000x7000 scan
        // the trace time scales with pixel count, so 1200 roughly halves
        // the wait with barely perceptible quality loss on line art.
        const MAX=1200;
        const scale=Math.min(1,MAX/Math.max(img.width,img.height));
        const w=Math.round(img.width*scale),h=Math.round(img.height*scale);
        const cnv=document.createElement("canvas");
        cnv.width=w;cnv.height=h;
        const ctx=cnv.getContext("2d");
        ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
        ctx.drawImage(img,0,0,w,h);
        // Preprocess: grayscale + threshold → high-contrast B&W. This is what
        // turns pencil/pen sketches on paper into clean vector lines.
        const id=ctx.getImageData(0,0,w,h);
        const d=id.data;
        let sum=0,count=0;
        for(let i=0;i<d.length;i+=4){const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];sum+=g;count++;}
        // Threshold = mean - 25 (biases toward preserving dark strokes without
        // catching paper shading). Works well for photos of white paper.
        const thresh=Math.max(60,Math.min(210,(sum/count)-25));
        for(let i=0;i<d.length;i+=4){
          const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
          const v=g<thresh?0:255;
          d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;
        }
        ctx.putImageData(id,0,0);
        report("trace",0);
        // Trace. 2-colour palette (black/white), tuned for line drawings.
        // Run in a microtask so the UI paints the "Tracing…" stage before
        // the main thread is blocked by imagedataToSVG. ImageTracer is
        // synchronous — there's no mid-trace callback — but at least the
        // user sees the bar move into this stage rather than appearing to
        // hang.
        setTimeout(()=>{
          let svgstr;
          try{
            // Aggressive path reduction so svg2pdf doesn't have to re-draw
            // thousands of tiny noise blobs for grainy scans:
            //   pathomit 24  → drop any path with <24 points (was 8)
            //   ltres    2.5 → coarser line fit (was 1)
            //   qtres    2.5 → coarser curve fit (was 1)
            // Visible quality loss on pure line drawings is minimal; the
            // PDF-render stage gets ~5-10× faster on HABS-scan-class inputs.
            svgstr=window.ImageTracer.imagedataToSVG(id,{
              numberofcolors:2,pathomit:24,ltres:2.5,qtres:2.5,
              strokewidth:1,linefilter:true,
              colorsampling:0,colorquantcycles:1,mincolorratio:0,
              pal:[{r:255,g:255,b:255,a:255},{r:0,g:0,b:0,a:255}],
            });
          }catch(e){return reject(new Error("Tracing failed: "+e.message));}
          report("svg",0);
          continueAfterTrace(svgstr);
        },40);
        return;
        function continueAfterTrace(svgstrArg){
          let svgstr=svgstrArg;
        // Drop the white background rectangle ImageTracer emits so the PDF
        // doesn't carry a huge solid-white path. svg2pdf would render it fine,
        // but it bloats the file.
        svgstr=svgstr.replace(/<path[^>]*fill="rgb\(255,255,255\)"[^>]*\/>/g,"");
        // Build an SVG DOM element for svg2pdf.
        const parser=new DOMParser();
        const svgDoc=parser.parseFromString(svgstr,"image/svg+xml");
        const svgEl=svgDoc.documentElement;
        // Render to A4 landscape preserving image aspect; svg2pdf honours the
        // SVG viewBox, so everything stays vector.
        const{jsPDF}=window.jspdf;
        const landscape=w>=h;
        const doc=new jsPDF({orientation:landscape?"l":"p",unit:"mm",format:"a4"});
        const pageW=landscape?297:210,pageH=landscape?210:297;
        const margin=10;
        const scaleFit=Math.min((pageW-margin*2)/w,(pageH-margin*2)/h);
        const drawW=w*scaleFit,drawH=h*scaleFit;
        const ox=(pageW-drawW)/2,oy=(pageH-drawH)/2;
        report("pdf",0);
        // svg2pdf exposes no per-path progress callback, so fake a slow
        // creep from 0 → ~0.95 within the PDF stage. Interval is cleared
        // the moment the promise resolves/rejects so we snap to 100%.
        let pdfTick=0;
        const pdfCreep=setInterval(()=>{
          pdfTick=Math.min(0.95,pdfTick+0.04);
          report("pdf",pdfTick);
        },500);
        window.svg2pdf(svgEl,doc,{x:ox,y:oy,width:drawW,height:drawH})
          .then(()=>{
            clearInterval(pdfCreep);
            doc.setFont("helvetica","normal");doc.setFontSize(7);
            doc.setTextColor(120);
            doc.text(`Vectorised from ${file.name} — SiteShrimp Convert`,margin,pageH-5);
            const blob=doc.output("blob");
            resolve(blob);
          }).catch(e=>{clearInterval(pdfCreep);reject(new Error("PDF build failed: "+e.message));});
        }
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });

  // Load the four bundled sample drawings from the public GitHub repo. Lets
  // testers kick the tyres on TAG / Compare / Convert with zero setup — no
  // need to find their own drawings first.
  // License/provenance-tagged so every drawing carries its own credit line.
  // See sample_drwgs/ATTRIBUTION.md for full sources and licences.
  const SAMPLE_URLS=[
    {name:"SampleHouse V1 (vector, CC0)",url:"https://raw.githubusercontent.com/woonweipong-hub/SiteShrimp/main/sample_drwgs/SampleHouse_V1.pdf",credit:"Original work by SiteShrimp — released CC0 / public domain."},
    {name:"SampleHouse V2 (vector, CC0)",url:"https://raw.githubusercontent.com/woonweipong-hub/SiteShrimp/main/sample_drwgs/SampleHouse_V2.pdf",credit:"Original work by SiteShrimp — released CC0 / public domain."},
    {name:"Dyckman House — First Floor (HABS, public domain)",url:"https://raw.githubusercontent.com/woonweipong-hub/SiteShrimp/main/sample_drwgs/Dyckman_First_Floor_sketch.png",credit:"Historic American Buildings Survey (HABS NY,31-NEYO,11-, sheet 2) — Library of Congress. Public domain (US federal work)."},
    {name:"Dyckman House — Second Floor (HABS, public domain)",url:"https://raw.githubusercontent.com/woonweipong-hub/SiteShrimp/main/sample_drwgs/Dyckman_Second_Floor_sketch.png",credit:"Historic American Buildings Survey (HABS NY,31-NEYO,11-, sheet 3) — Library of Congress. Public domain (US federal work)."},
  ];
  const[loadingSamples,setLoadingSamples]=useState(false);
  const loadSampleDrawings=async()=>{
    if(!company?.companyId||!currentProject?.id){alert("Pick a project first.");return;}
    setLoadingSamples(true);
    const created=[];
    for(const s of SAMPLE_URLS){
      try{
        const resp=await fetch(s.url);
        if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
        const blob=await resp.blob();
        const fname=s.url.split("/").pop();
        const file=new File([blob],fname,{type:blob.type||"application/octet-stream"});
        const rec=await DB.drawings.createWithFile({
          companyId:company.companyId,projectId:currentProject.id,
          // The drawing name itself carries the licence tag ("(HABS, public
          // domain)" / "(CC0)") so provenance follows the record everywhere
          // it's shown — no schema change needed.
          name:s.name,
          uploadedBy:member?.name||"",uploadedAt:new Date().toISOString(),
        },"file",file,fname);
        created.push(rec);
      }catch(err){console.warn("sample load failed",s.name,err);}
    }
    if(created.length)setDrawings(prev=>[...created,...prev]);
    setLoadingSamples(false);
    alert(`Loaded ${created.length}/${SAMPLE_URLS.length} sample drawings.\n\nSources:\n• SampleHouse V1/V2 — Original SiteShrimp work, CC0.\n• Dyckman House — HABS (Library of Congress), public domain.\n\nSee sample_drwgs/ATTRIBUTION.md for full details.`);
  };

  // Convert button handler: single or batch. Each JPG becomes one vector PDF
  // drawing record so the user can immediately Compare between versions.
  const convertJpgsToPdf=async(e)=>{
    const files=Array.from(e.target.files||[]).filter(f=>/^image\//.test(f.type));
    if(!files.length)return;
    convertCancelRef.current=false;
    setConverting(true);
    const created=[];
    let cancelledAfter=0;
    const stagesOrder=["read","decode","preprocess","trace","svg","pdf","upload"];
    const stageLabels={read:"Reading",decode:"Decoding image",preprocess:"Preprocessing",trace:"Tracing paths",svg:"Building SVG",pdf:"Rendering PDF",upload:"Uploading"};
    const totalWeight=stagesOrder.reduce((s,k)=>s+STAGE_WEIGHTS[k],0);
    const pctAtStageStart=(stage)=>{
      let acc=0;
      for(const k of stagesOrder){if(k===stage)return acc;acc+=STAGE_WEIGHTS[k];}
      return acc;
    };
    for(let i=0;i<files.length;i++){
      if(convertCancelRef.current){cancelledAfter=i;break;}
      const f=files[i];
      const baseFrac=i/files.length;
      const perFile=1/files.length;
      const emit=(stage,within=0)=>{
        const stagePct=(pctAtStageStart(stage)+STAGE_WEIGHTS[stage]*within)/totalWeight;
        const overall=Math.min(100,Math.round((baseFrac+perFile*stagePct)*100));
        setConvertProgress({
          label:`${stageLabels[stage]||stage} — ${f.name}`,
          pct:overall,
          fileIdx:i+1,totalFiles:files.length,
        });
      };
      emit("read",0);
      try{
        const blob=await traceOneToPdfBlob(f,emit);
        emit("upload",0);
        const baseName=f.name.replace(/\.[^.]+$/,"")+" (vector).pdf";
        const pdfFile=new File([blob],baseName,{type:"application/pdf"});
        const rec=await DB.drawings.createWithFile({
          companyId:company.companyId,
          projectId:currentProject.id,
          name:baseName.replace(/\.pdf$/i,""),
          uploadedBy:member?.name||"",
          uploadedAt:new Date().toISOString(),
        },"file",pdfFile,pdfFile.name);
        created.push(rec);
        // Also trigger a local download so the user has an offline copy of
        // the vector PDF — same file that was just uploaded. Lands in the
        // browser/OS default Downloads folder. Tap Up later to re-import.
        try{
          const a=document.createElement("a");
          const objUrl=URL.createObjectURL(blob);
          a.href=objUrl;a.download=baseName;
          document.body.appendChild(a);a.click();document.body.removeChild(a);
          setTimeout(()=>URL.revokeObjectURL(objUrl),1000);
        }catch{}
      }catch(err){
        console.warn("convert failed for",f.name,err);
        alert(`Failed to convert ${f.name}: ${err.message}`);
      }
    }
    if(created.length)setDrawings(prev=>[...created,...prev]);
    setConvertProgress(null);
    setConverting(false);
    if(convertRef.current)convertRef.current.value="";
    if(convertCancelRef.current){
      const remaining=files.length-cancelledAfter;
      alert(`Stopped. ${created.length} converted, ${remaining} skipped.`);
    }
    convertCancelRef.current=false;
  };

  const deleteDrawing=async id=>{
    if(!confirm("Delete this drawing and all its pins?"))return;
    try{
      // Delete associated pins first
      const pins=await DB.pins.list(`drawingId="${id}"`);
      for(const p of pins)await DB.pins.delete(p.id);
      await DB.drawings.delete(id);
      setDrawings(prev=>prev.filter(d=>d.id!==id));
    }catch(e){alert("Delete failed: "+e.message);}
  };

  const openCompare=()=>{
    if(pdfDrawings.length<2)return;
    setCompareError("");setCompareRes(null);
    const first=pdfDrawings[0]?.id||"";
    const second=pdfDrawings[1]?.id||first;
    setCompareBaseId(prev=>prev||first);
    setCompareTargetId(prev=>prev||(second===first?"":second));
    setShowCompare(true);
  };

  // ── Batch Compare ────────────────────────────────────────────────
  const handleBatchFolder=(e,setter)=>{
    const files=Array.from(e.target.files||[]).filter(f=>/\.pdf$/i.test(f.name));
    setter(files);
    e.target.value="";
  };

  // Fuzzy filename matching — strips common suffixes/prefixes and compares core name
  const normalizeName=(name)=>{
    return name.replace(/\.pdf$/i,"")
      .replace(/[\s_-]+/g," ").trim().toUpperCase()
      .replace(/\b(REV|REVISION|AS[- ]?BUILT|TENDER|DRAFT|FINAL|V\d+|R\d+)\b/gi,"")
      .replace(/\s+/g," ").trim();
  };

  const similarityScore=(a,b)=>{
    if(a===b)return 1;
    const shorter=a.length<b.length?a:b;
    const longer=a.length>=b.length?a:b;
    if(longer.length===0)return 0;
    // Check if one contains the other
    if(longer.includes(shorter))return shorter.length/longer.length;
    // Simple word overlap
    const wordsA=new Set(a.split(" "));const wordsB=new Set(b.split(" "));
    let overlap=0;wordsA.forEach(w=>{if(wordsB.has(w))overlap++;});
    return overlap/Math.max(wordsA.size,wordsB.size);
  };

  const runBatchMatch=()=>{
    if(!batchSetAFiles.length||!batchSetBFiles.length)return;
    const setANorms=batchSetAFiles.map(f=>({file:f,norm:normalizeName(f.name)}));
    const setBNorms=batchSetBFiles.map(f=>({file:f,norm:normalizeName(f.name)}));
    const matched=[];const usedA=new Set();const usedB=new Set();
    const pairs=[];
    setANorms.forEach((a,ai)=>{
      setBNorms.forEach((b,bi)=>{
        const score=similarityScore(a.norm,b.norm);
        if(score>0.3)pairs.push({ai,bi,score,fileA:a.file,fileB:b.file});
      });
    });
    pairs.sort((a,b)=>b.score-a.score);
    pairs.forEach(p=>{
      if(usedA.has(p.ai)||usedB.has(p.bi))return;
      matched.push({fileA:p.fileA,fileB:p.fileB,similarity:p.score});
      usedA.add(p.ai);usedB.add(p.bi);
    });
    setBatchMatches(matched);
    setBatchUnmatchedA(batchSetAFiles.filter((_,i)=>!usedA.has(i)));
    setBatchUnmatchedB(batchSetBFiles.filter((_,i)=>!usedB.has(i)));
    setBatchResults([]);
  };

  useEffect(()=>{
    if(batchSetAFiles.length&&batchSetBFiles.length)runBatchMatch();
  },[batchSetAFiles,batchSetBFiles]);

  const readFileAsDataUrl=(file)=>new Promise((res,rej)=>{
    const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file);
  });

  const extractPdfLinesFromBlob=async(file)=>{
    const url=URL.createObjectURL(file);
    try{return await extractPdfLines(url);}finally{URL.revokeObjectURL(url);}
  };

  const[batchExpandedIdx,setBatchExpandedIdx]=useState(null);

  const runBatchCompare=async()=>{
    if(!batchMatches.length)return;
    setBatchRunning(true);setBatchResults([]);setBatchExpandedIdx(null);
    setBatchProgress({current:0,total:batchMatches.length});
    const results=[];
    for(let i=0;i<batchMatches.length;i++){
      const m=batchMatches[i];
      setBatchProgress({current:i+1,total:batchMatches.length});
      try{
        const[linesA,linesB]=await Promise.all([extractPdfLinesFromBlob(m.fileA),extractPdfLinesFromBlob(m.fileB)]);
        const diff=comparePdfLineSets(linesA,linesB);
        results.push({nameA:m.fileA.name,nameB:m.fileB.name,added:diff.added.length,removed:diff.removed.length,addedLines:diff.added.slice(0,50),removedLines:diff.removed.slice(0,50),pagesA:linesA.length?Math.max(...linesA.map(l=>l.pageNum||1)):0,pagesB:linesB.length?Math.max(...linesB.map(l=>l.pageNum||1)):0,linesA:linesA.length,linesB:linesB.length,status:diff.added.length===0&&diff.removed.length===0?"identical":"changed",similarity:m.similarity});
      }catch(e){
        results.push({nameA:m.fileA.name,nameB:m.fileB.name,added:0,removed:0,addedLines:[],removedLines:[],pagesA:0,pagesB:0,linesA:0,linesB:0,status:"error",error:e.message,similarity:m.similarity});
      }
      setBatchResults([...results]);
    }
    setBatchRunning(false);
  };

  const exportBatchCsv=()=>{
    if(!batchResults.length&&!batchUnmatchedA.length&&!batchUnmatchedB.length)return;
    const cc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const header=["Section","Status",batchLabelA,batchLabelB,"Pages A","Pages B","Lines Added","Lines Removed","Detail"];
    const rows=[];
    // Completeness
    batchUnmatchedA.forEach(f=>rows.push(["COMPLETENESS","MISSING",f.name,"—","—","—","—","—","Only in "+batchLabelA]));
    batchUnmatchedB.forEach(f=>rows.push(["COMPLETENESS","EXTRA","—",f.name,"—","—","—","—","Only in "+batchLabelB]));
    // Content results
    batchResults.forEach(r=>{
      rows.push(["CONTENT",r.status.toUpperCase(),r.nameA,r.nameB,r.pagesA||"",r.pagesB||"",r.added,r.removed,""]);
      if(r.status==="changed"){
        (r.addedLines||[]).forEach(l=>rows.push(["DETAIL","ADDED_IN_"+batchLabelB.replace(/\s/g,"_"),r.nameA,r.nameB,"","","","",l.text||l]));
        (r.removedLines||[]).forEach(l=>rows.push(["DETAIL","REMOVED_FROM_"+batchLabelA.replace(/\s/g,"_"),r.nameA,r.nameB,"","","","",l.text||l]));
      }
    });
    const csv=[header,...rows].map(r=>r.map(cc).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${fileTimestamp()}-batch_compare_report.csv`;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  const exportBatchPdf=()=>{
    const stamp=new Date().toLocaleString();
    const lblA=sanitize(batchLabelA);const lblB=sanitize(batchLabelB);
    const identical=batchResults.filter(r=>r.status==="identical").length;
    const changed=batchResults.filter(r=>r.status==="changed").length;
    const errors=batchResults.filter(r=>r.status==="error").length;
    const isComplete=batchUnmatchedA.length===0&&batchUnmatchedB.length===0&&batchSetAFiles.length===batchSetBFiles.length;
    // Completeness section
    const unmatchedHtml=[...batchUnmatchedA.map(f=>`<tr style="background:#fff3f2"><td style="color:#ff3b30;font-weight:bold">MISSING</td><td>${sanitize(f.name)}</td><td style="color:#999;font-style:italic">No match in ${lblB}</td></tr>`),...batchUnmatchedB.map(f=>`<tr style="background:#fffbe6"><td style="color:#ff9500;font-weight:bold">EXTRA</td><td style="color:#999;font-style:italic">No match in ${lblA}</td><td>${sanitize(f.name)}</td></tr>`)].join("");
    // Content results table
    const resultRows=batchResults.map((r,i)=>`<tr style="background:${r.status==="identical"?"#f0fff5":r.status==="error"?"#fff3f2":"#fffbe6"}"><td>${i+1}</td><td>${sanitize(r.nameA)}</td><td>${sanitize(r.nameB)}</td><td style="color:#ff3b30;font-weight:bold">${r.status==="error"?"ERR":r.added>0?"+"+r.added:"0"}</td><td style="color:#34c759;font-weight:bold">${r.status==="error"?"ERR":r.removed>0?"-"+r.removed:"0"}</td><td style="font-weight:bold;color:${r.status==="identical"?"#34c759":r.status==="error"?"#ff3b30":"#ff9500"}">${r.status==="identical"?"IDENTICAL":r.status==="error"?"ERROR":"CHANGED"}</td></tr>`).join("");
    // Per-file detail for changed files
    const detailSections=batchResults.filter(r=>r.status==="changed").map(r=>{
      const addedHtml=(r.addedLines||[]).slice(0,20).map(l=>`<div style="font-size:10px;padding:2px 6px;margin:1px 0;background:#fff3f8;border-left:3px solid #ff00ff;border-radius:2px">${sanitize(l.text||l)}</div>`).join("")+(r.added>20?`<div style="font-size:10px;color:#999;padding-left:8px">... and ${r.added-20} more</div>`:"");
      const removedHtml=(r.removedLines||[]).slice(0,20).map(l=>`<div style="font-size:10px;padding:2px 6px;margin:1px 0;background:#fffde6;border-left:3px solid #ddcc00;border-radius:2px">${sanitize(l.text||l)}</div>`).join("")+(r.removed>20?`<div style="font-size:10px;color:#999;padding-left:8px">... and ${r.removed-20} more</div>`:"");
      return`<div style="page-break-inside:avoid;margin-bottom:14px;border:1px solid #ddd;border-radius:8px;padding:12px"><div style="font-weight:bold;font-size:13px;margin-bottom:6px">${sanitize(r.nameA)} <span style="color:#999;font-weight:normal">↔</span> ${sanitize(r.nameB)}</div><div style="font-size:11px;color:#666;margin-bottom:6px">Pages: ${r.pagesA||"?"} vs ${r.pagesB||"?"} · Text lines: ${r.linesA||0} vs ${r.linesB||0}</div>${addedHtml?`<div style="margin-bottom:6px"><div style="font-size:10px;font-weight:bold;color:#ff00ff;margin-bottom:3px">+ IN ${lblB} ONLY (${r.added})</div>${addedHtml}</div>`:""}${removedHtml?`<div><div style="font-size:10px;font-weight:bold;color:#b8a700;margin-bottom:3px">- IN ${lblA} ONLY (${r.removed})</div>${removedHtml}</div>`:""}</div>`;
    }).join("");
    const w=window.open("","_blank");
    if(!w){alert("Popup blocked.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-Batch Comparison Report</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:1000px;margin:0 auto}h1{margin:0 0 4px;font-size:22px}h2{margin:18px 0 8px;font-size:16px;border-bottom:2px solid #ddd;padding-bottom:4px}.meta{font-size:12px;color:#444;margin-bottom:6px}.cards{display:flex;gap:10px;margin:12px 0}.card{flex:1;border-radius:8px;padding:12px;border:1px solid #ddd;text-align:center}.card b{display:block;font-size:22px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f5f5f5;text-align:left}.status{font-size:12px;font-weight:bold;padding:6px 12px;border-radius:6px;display:inline-block;margin:6px 0}@media print{.no-print{display:none}}</style></head><body>
      <h1>Batch PDFs Comparison Report</h1>
      <div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")} | <b>Generated:</b> ${sanitize(stamp)}</div>
      <h2>1. Completeness Check</h2>
      <div class="cards"><div class="card" style="border-color:#5856d6;background:#f5f3ff"><b>${batchSetAFiles.length}</b><span style="font-size:11px;color:#5856d6">${lblA}</span></div><div class="card" style="border-color:#ff6b00;background:#fff8f3"><b>${batchSetBFiles.length}</b><span style="font-size:11px;color:#ff6b00">${lblB}</span></div><div class="card" style="border-color:#34c759;background:#f0fff5"><b>${batchMatches.length}</b><span style="font-size:11px;color:#34c759">Paired</span></div><div class="card" style="border-color:#ff3b30;background:#fff3f2"><b>${batchUnmatchedA.length+batchUnmatchedB.length}</b><span style="font-size:11px;color:#ff3b30">Unpaired</span></div></div>
      <div class="status" style="background:${isComplete?"#f0fff5":"#fffbe6"};color:${isComplete?"#1a7a35":"#b36b00"};border:1px solid ${isComplete?"#9cd8ad":"#e6c800"}">${isComplete?`COMPLETE — All ${batchSetAFiles.length} drawings accounted for`:`GAPS FOUND — ${batchUnmatchedA.length+batchUnmatchedB.length} unpaired file(s), count difference: ${Math.abs(batchSetAFiles.length-batchSetBFiles.length)}`}</div>
      ${unmatchedHtml?`<table><thead><tr><th>Status</th><th>${lblA}</th><th>${lblB}</th></tr></thead><tbody>${unmatchedHtml}</tbody></table>`:""}
      <h2>2. Content Comparison</h2>
      <div class="cards"><div class="card" style="border-color:#34c759;background:#f0fff5"><b>${identical}</b><span style="font-size:11px;color:#34c759">Identical</span></div><div class="card" style="border-color:#ff9500;background:#fffbe6"><b>${changed}</b><span style="font-size:11px;color:#ff9500">Changed</span></div><div class="card" style="border-color:#ff3b30;background:#fff3f2"><b>${errors}</b><span style="font-size:11px;color:#ff3b30">Errors</span></div></div>
      <table><thead><tr><th>#</th><th>${lblA}</th><th>${lblB}</th><th>Added</th><th>Removed</th><th>Status</th></tr></thead><tbody>${resultRows}</tbody></table>
      ${detailSections?`<h2>3. Change Details (per file)</h2>${detailSections}`:""}
      <br><button class="no-print" onclick="window.print()">Print / Save as PDF</button>
    </body></html>`);
    w.document.close();
  };

  const runCompare=async()=>{
    const base=drawings.find(d=>d.id===compareBaseId);
    const target=drawings.find(d=>d.id===compareTargetId);
    if(!base||!target||base.id===target.id){
      setCompareError("Choose 2 different PDF drawings.");
      return;
    }
    setComparing(true);setCompareError("");setCompareRes(null);setCompareZoom(1);setComparePan({x:0,y:0});setDiffEdits({});
    setCompareAiError("");setCompareAiReport("");
    setCompareAiLocked(false);setCompareAiApprovedBy("");setCompareAiApprovedAt(null);setCompareAuditLog([]);
    try{
      const baseUrl=DB.fileUrl("drawings",base.id,base.file);
      const targetUrl=DB.fileUrl("drawings",target.id,target.file);
      const[baseLines,targetLines]=await Promise.all([extractPdfLines(baseUrl),extractPdfLines(targetUrl)]);
      const diff=comparePdfLineSets(baseLines,targetLines);
      setCompareRes({
        baseName:base.name,
        targetName:target.name,
        added:diff.added.slice(0,250),
        removed:diff.removed.slice(0,250),
        totalAdded:diff.added.length,
        totalRemoved:diff.removed.length,
        generatedAt:Date.now()
      });
    }catch(e){
      setCompareError(e.message||"Comparison failed");
    }
    setComparing(false);
  };

  const runCompareAi=async()=>{
    if(!compareRes)return;
    if(compareAiLocked){setCompareAiError("AI report is locked. Unlock before regenerating.");return;}
    if(!aiReady){setCompareAiError("AI is not configured. Set up AI provider in AI Setup first.");return;}
    const today=new Date().toISOString().slice(0,10);
    const aiUsage=local.get(AI_LIMIT_KEY)||{date:"",count:0};
    const todayCount=aiUsage.date===today?aiUsage.count:0;
    if(todayCount>=AI_DAILY_LIMIT){
      setCompareAiError(`AI analysis limit reached (${AI_DAILY_LIMIT}/day).`);
      return;
    }
    setCompareAiBusy(true);setCompareAiError("");
    try{
      const sampleAdded=(compareRes.added||[]).slice(0,80).map(l=>l.text||l);
      const sampleRemoved=(compareRes.removed||[]).slice(0,80).map(l=>l.text||l);
      const prompt=`You are reviewing drawing revisions for construction compliance and coordination.
Project: ${currentProject?.name||"Unknown"}
Company: ${company?.companyName||"Unknown"}
Base drawing: ${compareRes.baseName}
Revision drawing: ${compareRes.targetName}
Detected changes: ${compareRes.totalAdded} added lines, ${compareRes.totalRemoved} removed lines.

Added lines sample:\n${sampleAdded.join("\n")||"(none)"}

Removed lines sample:\n${sampleRemoved.join("\n")||"(none)"}

Return valid JSON only with this shape:
{
  "executive_summary": "3-5 sentence summary",
  "key_impacts": ["max 8 bullets"],
  "risks": ["max 8 bullets"],
  "recommended_actions": ["max 10 actions with owner/trade hints"],
  "submission_notes_bca_scdf": ["max 6 bullets for submission/audit context"]
}`;
      const raw=await askAI(prompt);
      if(!raw)throw new Error("AI returned no response");
      let parsed;
      try{parsed=JSON.parse(String(raw).replace(/```json|```/g,"").trim());}
      catch{throw new Error("AI response could not be parsed");}
      const section=(title,arr)=>`${title}:\n${(arr||[]).length?(arr||[]).map((x,i)=>`${i+1}. ${x}`).join("\n"):"-"}`;
      const report=[
        `Executive Summary:\n${parsed.executive_summary||"-"}`,
        section("Key Impacts",parsed.key_impacts),
        section("Risks",parsed.risks),
        section("Recommended Actions",parsed.recommended_actions),
        section("Submission Notes (BCA/SCDF)",parsed.submission_notes_bca_scdf)
      ].join("\n\n");
      setCompareAiReport(report);
      local.set(AI_LIMIT_KEY,{date:today,count:todayCount+1});
    }catch(e){
      setCompareAiError(e.message||"AI analysis failed");
    }
    setCompareAiBusy(false);
  };

  const regenerateCompareAi=async()=>{
    if(compareAiLocked){setCompareAiError("AI report is locked. Unlock before regenerating.");return;}
    setCompareAiReport("");
    await runCompareAi();
  };

  const aiRenameDiffItems=async()=>{
    if(!compareRes||!aiReady)return;
    const allItems=[];
    compareRes.added.forEach((l,i)=>{if(!diffEdits[`added_${i}`]?.name)allItems.push({key:`added_${i}`,type:"added",text:l?.text||l});});
    compareRes.removed.forEach((l,i)=>{if(!diffEdits[`removed_${i}`]?.name)allItems.push({key:`removed_${i}`,type:"removed",text:l?.text||l});});
    if(allItems.length===0){setCompareAiError("All items already renamed.");return;}
    setAiRenameBusy(true);setCompareAiError("");
    try{
      const batch=allItems.slice(0,50);
      const prompt=`You are analyzing extracted text lines from construction/architectural PDF drawings. Each line was extracted from a floor plan and contains raw text content (numbers, labels, dimensions, room names, annotations).

Identify each line as a recognizable construction object or element. Return a JSON array of objects with "key" and "name" fields.

Rules:
- Name should be a short, clear description: "Wall dimension", "Room label - Bedroom 2", "Grid line A", "Door schedule ref", "Window W1", "Column C4", "Staircase", "Dimension string", etc.
- If the line is just numbers/coordinates, name it "Dimension" or "Grid reference"
- If it contains a room name, include it: "Room label - Kitchen"
- Keep names under 40 characters
- Return ONLY valid JSON array, no other text

Lines to identify:
${batch.map((item,i)=>`${i+1}. [${item.key}] "${item.text}"`).join("\n")}`;
      const resp=await askAI(prompt);
      let parsed;
      try{
        const match=resp.match(/\[[\s\S]*\]/);
        parsed=match?JSON.parse(match[0]):[];
      }catch{parsed=[];}
      if(parsed.length>0){
        const newEdits={...diffEdits};
        parsed.forEach(item=>{
          if(item.key&&item.name){
            newEdits[item.key]={name:item.name,remark:newEdits[item.key]?.remark||""};
          }
        });
        setDiffEdits(newEdits);
      }else{
        setCompareAiError("AI could not identify items. Try again.");
      }
    }catch(e){
      setCompareAiError(e.message||"AI rename failed");
    }
    setAiRenameBusy(false);
  };

  const logCompareAudit=(action,details={})=>{
    const entry={action,by:member?.name||"Unknown",at:Date.now(),...details};
    setCompareAuditLog(prev=>[entry,...prev]);
    DB.activity.create({
      companyId:company?.companyId||"",
      projectId:currentProject?.id||"",
      type:"compare_audit",
      action,
      userName:member?.name||"",
      userId:authUser?.id||"",
      baseName:compareRes?.baseName||"",
      targetName:compareRes?.targetName||"",
      reason:details.reason||"",
      createdAt:new Date().toISOString()
    }).catch(e=>console.warn("Audit log save failed:",e));
  };

  const approveAndLockCompareAi=()=>{
    if(!compareAiReport)return;
    setCompareAiLocked(true);
    setCompareAiApprovedBy(member?.name||"Unknown");
    setCompareAiApprovedAt(Date.now());
    setCompareAiError("");
    logCompareAudit("lock",{reason:"Approved AI report"});
  };

  const unlockCompareAi=()=>{
    setShowUnlockPrompt(true);
    setUnlockReason("");
  };

  const confirmUnlock=(reason)=>{
    setCompareAiLocked(false);
    setCompareAiApprovedBy("");
    setCompareAiApprovedAt(null);
    setShowUnlockPrompt(false);
    logCompareAudit("unlock",{reason:reason||"No reason provided"});
    setUnlockReason("");
  };

  const saveComparison=async()=>{
    if(!compareRes&&!compareOverlayCanvasRef.current?.width){alert("Run a comparison first.");return;}
    // Save compact preview thumbnail (quick offline preview)
    // Full vector quality re-renders from source PDFs when opened
    let overlayThumb="";
    try{
      const oc=compareOverlayCanvasRef.current;
      if(oc&&oc.width){
        const tmp=document.createElement("canvas");
        const scale=Math.min(1200/oc.width,900/oc.height,1);
        tmp.width=Math.round(oc.width*scale);tmp.height=Math.round(oc.height*scale);
        const tctx=tmp.getContext("2d");
        tctx.drawImage(oc,0,0,tmp.width,tmp.height);
        // Preload photo strokes so images are available during sync composite
        const imgCache=await _preloadStrokePhotos(compareMarkupStrokes);
        // Composite compare markup strokes on top so the saved thumb shows annotations
        (compareMarkupStrokes||[]).forEach(s=>_drawMarkupStroke(tctx,tmp.width,tmp.height,s,imgCache));
        overlayThumb=tmp.toDataURL("image/jpeg",0.85);
      }
    }catch(e){console.warn("Overlay thumbnail with markup failed",e);}
    const record={
      id:`cmp_${Date.now()}`,
      savedAt:Date.now(),
      baseName:compareRes?.baseName||drawings.find(d=>d.id===compareBaseId)?.name||"Base",
      targetName:compareRes?.targetName||drawings.find(d=>d.id===compareTargetId)?.name||"Revision",
      baseId:compareBaseId,targetId:compareTargetId,
      totalAdded:compareRes?.totalAdded||0,totalRemoved:compareRes?.totalRemoved||0,
      added:compareRes?.added||[],removed:compareRes?.removed||[],
      aiReport:compareAiReport||"",aiLocked:compareAiLocked,
      aiApprovedBy:compareAiApprovedBy,aiApprovedAt:compareAiApprovedAt,
      auditLog:[...compareAuditLog],
      markups:[...compareMarkupStrokes],
      diffEdits:{...diffEdits},
      overlayThumb,
      savedBy:member?.name||""
    };
    const list=[record,...savedComparisons];
    setSavedComparisons(list);
    if(currentProject?.id){const all=local.get(SAVED_COMPARISONS_KEY)||{};all[currentProject.id]=list;local.set(SAVED_COMPARISONS_KEY,all);}
    setShowCompare(false);
  };

  const deleteSavedComparison=(id)=>{
    if(!confirm("Delete this saved comparison?"))return;
    const list=savedComparisons.filter(c=>c.id!==id);
    setSavedComparisons(list);
    if(currentProject?.id){const all=local.get(SAVED_COMPARISONS_KEY)||{};all[currentProject.id]=list;local.set(SAVED_COMPARISONS_KEY,all);}
  };

  const loadSavedComparison=(saved)=>{
    setCompareBaseId(saved.baseId||"");
    setCompareTargetId(saved.targetId||"");
    setCompareRes({baseName:saved.baseName,targetName:saved.targetName,added:saved.added||[],removed:saved.removed||[],totalAdded:saved.totalAdded,totalRemoved:saved.totalRemoved,generatedAt:saved.savedAt});
    setCompareAiReport(saved.aiReport||"");
    setCompareAiLocked(saved.aiLocked||false);
    setCompareAiApprovedBy(saved.aiApprovedBy||"");
    setCompareAiApprovedAt(saved.aiApprovedAt||null);
    setCompareAuditLog(saved.auditLog||[]);
    setCompareMarkupStrokes(saved.markups||[]);
    setDiffEdits(saved.diffEdits||{});
    setViewingSaved(saved.id);
    setShowCompare(true);
  };

  const getCompareMarkupPos=e=>{
    const board=compareBoardRef.current;
    if(!board)return null;
    const rect=board.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{
      x:Math.max(0,Math.min(100,((t.clientX-rect.left)/rect.width)*100)),
      y:Math.max(0,Math.min(100,((t.clientY-rect.top)/rect.height)*100))
    };
  };

  // Hit-test: find topmost photo stroke under point
  const hitComparePhotoAt=p=>{
    for(let i=compareMarkupStrokes.length-1;i>=0;i--){
      const s=compareMarkupStrokes[i];
      if(s.type!=="photo"||!s.pos)continue;
      if(p.x>=s.pos.x&&p.x<=s.pos.x+s.w&&p.y>=s.pos.y&&p.y<=s.pos.y+s.h)return i;
    }
    return -1;
  };
  const hitCompareResizeHandle=(p,idx)=>{
    const s=compareMarkupStrokes[idx];if(!s||s.type!=="photo")return false;
    const hx=s.pos.x+s.w,hy=s.pos.y+s.h;
    return Math.abs(p.x-hx)<2.2&&Math.abs(p.y-hy)<2.2;
  };
  const cancelComparePendingPhoto=()=>{setComparePendingPhoto(null);setComparePhotoPlaceRect(null);};

  const onCompareMarkupDown=e=>{
    // Pinch zoom — 2 fingers
    if(e.touches&&e.touches.length===2){
      e.preventDefault();
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      comparePinchDist.current=Math.sqrt(dx*dx+dy*dy);
      comparePanStart.current={x:(e.touches[0].clientX+e.touches[1].clientX)/2,y:(e.touches[0].clientY+e.touches[1].clientY)/2,px:comparePan.x,py:comparePan.y};
      return;
    }
    // Pan mode — when zoomed in and no markup tool active, or middle click
    if(compareZoom>1&&e.touches&&e.touches.length===1&&!compareMarkupTool){
      comparePanStart.current={x:e.touches[0].clientX,y:e.touches[0].clientY,px:comparePan.x,py:comparePan.y};
      return;
    }
    const p=getCompareMarkupPos(e);if(!p)return;
    e.preventDefault();
    // Drag to place a pending photo (rubber-band rect)
    if(comparePendingPhoto){
      setComparePhotoPlaceRect({x:p.x,y:p.y,w:0,h:0,startX:p.x,startY:p.y});
      return;
    }
    if(compareMarkupTool==="select"){
      // Check resize handle on selected photo
      if(compareSelectedIdx!=null&&hitCompareResizeHandle(p,compareSelectedIdx)){
        const s=compareMarkupStrokes[compareSelectedIdx];
        compareDragRef.current={idx:compareSelectedIdx,mode:"resize",startX:p.x,startY:p.y,orig:{...s}};
        return;
      }
      // Check photo hit for move
      const photoIdx=hitComparePhotoAt(p);
      if(photoIdx>=0){
        setCompareSelectedIdx(photoIdx);
        const s=compareMarkupStrokes[photoIdx];
        compareDragRef.current={idx:photoIdx,mode:"move",startX:p.x,startY:p.y,orig:{...s}};
        return;
      }
      // Clicking empty space deselects
      setCompareSelectedIdx(null);
      return;
    }
    if(compareMarkupTool==="text"){
      setCompareTextPoint(p);
      setCompareTextValue("");
      return;
    }
    if(compareMarkupTool==="polyline"){
      setCmpPolylinePoints(prev=>[...prev,p]);
      return;
    }
    if(compareMarkupTool==="stamp"){
      addCompareStroke({type:"stamp",color:compareMarkupColor,pos:p,stampId:cmpStampType,text:cmpStampType,fontSize:compareTextSize});
      return;
    }
    if(compareMarkupTool==="freehand")setCompareMarkupCurrent({type:"freehand",color:compareMarkupColor,points:[p]});
    else if(compareMarkupTool==="highlight")setCompareMarkupCurrent({type:"highlight",color:compareMarkupColor,points:[p]});
    else setCompareMarkupCurrent({type:compareMarkupTool,color:compareMarkupColor,lineStyle:compareMarkupLineStyle,start:p,end:p});
  };

  // Translate a stroke by (dx,dy) in percentage coords
  const translateStroke=(s,dx,dy)=>{
    const clamp=v=>Math.max(0,Math.min(100,v));
    if((s.type==="freehand"||s.type==="highlight"||s.type==="polyline")&&Array.isArray(s.points))return{...s,points:s.points.map(pt=>({x:clamp(pt.x+dx),y:clamp(pt.y+dy)}))};
    if(["arrow","circle","rect","line","dimension","cloud","callout"].includes(s.type)&&s.start&&s.end)return{...s,start:{x:clamp(s.start.x+dx),y:clamp(s.start.y+dy)},end:{x:clamp(s.end.x+dx),y:clamp(s.end.y+dy)}};
    if((s.type==="text"||s.type==="photo"||s.type==="stamp")&&s.pos)return{...s,pos:{x:clamp(s.pos.x+dx),y:clamp(s.pos.y+dy)}};
    return s;
  };

  const onCompareStrokeDown=(idx,e)=>{
    if(compareMarkupTool!=="select")return;
    e.preventDefault();e.stopPropagation();
    const p=getCompareMarkupPos(e);if(!p)return;
    setCompareSelectedIdx(idx);
    compareDragRef.current={idx,startX:p.x,startY:p.y,orig:compareMarkupStrokes[idx]};
  };

  const onCompareMarkupMove=e=>{
    // Rubber-band rect while placing a new photo
    if(comparePendingPhoto&&comparePhotoPlaceRect){
      const p=getCompareMarkupPos(e);if(!p)return;
      e.preventDefault();e.stopPropagation();
      const sx=comparePhotoPlaceRect.startX,sy=comparePhotoPlaceRect.startY;
      const x=Math.min(sx,p.x),y=Math.min(sy,p.y);
      const w=Math.abs(p.x-sx),h=Math.abs(p.y-sy);
      setComparePhotoPlaceRect({...comparePhotoPlaceRect,x,y,w,h});
      return;
    }
    // Dragging a selected stroke (move or resize)
    if(compareDragRef.current){
      const p=getCompareMarkupPos(e);if(!p)return;
      e.preventDefault();
      const d=compareDragRef.current;
      const dx=p.x-d.startX,dy=p.y-d.startY;
      if(d.mode==="resize"){
        setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>{
          if(i!==d.idx||s.type!=="photo")return s;
          const aspect=d.orig.h/d.orig.w;
          const nw=Math.max(4,Math.min(100-d.orig.pos.x,d.orig.w+dx));
          const nh=nw*aspect;
          return{...s,w:nw,h:Math.min(100-d.orig.pos.y,nh)};
        }));
        return;
      }
      setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>i===d.idx?translateStroke(d.orig,dx,dy):s));
      return;
    }
    // Pinch zoom move
    if(e.touches&&e.touches.length===2&&comparePinchDist.current){
      e.preventDefault();
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      const dist=Math.sqrt(dx*dx+dy*dy);
      const scale=dist/comparePinchDist.current;
      setCompareZoom(z=>Math.max(1,Math.min(5,z*scale)));
      comparePinchDist.current=dist;
      // Pan with pinch center
      if(comparePanStart.current){
        const cx=(e.touches[0].clientX+e.touches[1].clientX)/2;
        const cy=(e.touches[0].clientY+e.touches[1].clientY)/2;
        setComparePan({x:comparePanStart.current.px+(cx-comparePanStart.current.x),y:comparePanStart.current.py+(cy-comparePanStart.current.y)});
      }
      return;
    }
    // Single-finger pan when zoomed
    if(comparePanStart.current&&!compareMarkupCurrent&&e.touches?.length===1){
      const dx=e.touches[0].clientX-comparePanStart.current.x;
      const dy=e.touches[0].clientY-comparePanStart.current.y;
      setComparePan({x:comparePanStart.current.px+dx,y:comparePanStart.current.py+dy});
      return;
    }
    if(!compareMarkupCurrent)return;
    const p=getCompareMarkupPos(e);if(!p)return;
    e.preventDefault();
    if(compareMarkupCurrent.type==="freehand"||compareMarkupCurrent.type==="highlight")setCompareMarkupCurrent(c=>({...c,points:[...c.points,p]}));
    else setCompareMarkupCurrent(c=>({...c,end:p}));
  };

  const onCompareMarkupUp=()=>{
    comparePinchDist.current=null;comparePanStart.current=null;
    // Finalize pending photo placement
    if(comparePendingPhoto&&comparePhotoPlaceRect){
      let{x,y,w,h}=comparePhotoPlaceRect;
      if(w<3||h<3){
        w=30;h=30*comparePendingPhoto.aspect;
        x=Math.max(0,Math.min(100-w,(comparePhotoPlaceRect.startX||50)-w/2));
        y=Math.max(0,Math.min(100-h,(comparePhotoPlaceRect.startY||50)-h/2));
      }else{
        h=w*comparePendingPhoto.aspect;
        if(y+h>100)h=100-y;
      }
      const stroke={type:"photo",dataUrl:comparePendingPhoto.dataUrl,pos:{x,y},w,h};
      setCompareMarkupStrokes(s=>{setCompareSelectedIdx(s.length);return[...s,stroke];});
      setCompareRedoStack([]);
      setComparePendingPhoto(null);setComparePhotoPlaceRect(null);
      setCompareMarkupTool("select");
      compareDragRef.current=null;
      return;
    }
    compareDragRef.current=null;
    if(compareMarkupCurrent){
      if(compareMarkupCurrent.type==="dimension"){
        setComparePendingDim(compareMarkupCurrent);setCompareDimLabel("");setCompareMarkupCurrent(null);
        return;
      }
      if(compareMarkupCurrent.type==="callout"){
        setCmpCalloutStroke(compareMarkupCurrent);setCmpCalloutText("");setCompareMarkupCurrent(null);
        return;
      }
      addCompareStroke(compareMarkupCurrent);setCompareMarkupCurrent(null);
    }
  };
  const finishCmpPolyline=()=>{
    if(cmpPolylinePoints.length>1){
      addCompareStroke({type:"polyline",color:compareMarkupColor,points:[...cmpPolylinePoints],closed:cmpPolylineClosed,lineStyle:compareMarkupLineStyle});
    }
    setCmpPolylinePoints([]);
  };

  const undoCompareMarkup=()=>{setCompareMarkupStrokes(s=>{if(!s.length)return s;setCompareRedoStack(r=>[...r,s[s.length-1]]);return s.slice(0,-1);});};
  const redoCompareMarkup=()=>{setCompareRedoStack(r=>{if(!r.length)return r;const item=r[r.length-1];setCompareMarkupStrokes(s=>[...s,item]);return r.slice(0,-1);});};
  const clearCompareMarkup=()=>{if(compareMarkupStrokes.length&&confirm(t("markup.clear_compare")))setCompareMarkupStrokes([]);};

  const addCompareText=()=>{
    if(!compareTextPoint||!compareTextValue.trim())return;
    addCompareStroke({type:"text",color:compareMarkupColor,pos:compareTextPoint,text:compareTextValue.trim(),fontSize:compareTextSize,align:compareTextAlign,valign:compareTextValign});
    setCompareTextPoint(null);setCompareTextValue("");
  };

  // Update font size of the currently selected text stroke (and the default for new text)
  const setCompareTextSizeBoth=(size)=>{
    setCompareTextSize(size);
    if(compareSelectedIdx!=null){
      setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>(i===compareSelectedIdx&&s.type==="text")?{...s,fontSize:size}:s));
    }
  };

  // Update horizontal+vertical alignment of the currently selected text stroke (and defaults for new text)
  const setCompareTextAnchor=(valign,align)=>{
    setCompareTextValign(valign);
    setCompareTextAlign(align);
    if(compareSelectedIdx!=null){
      setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>(i===compareSelectedIdx&&s.type==="text")?{...s,align,valign}:s));
    }
  };

  const deleteCompareSelected=()=>{
    if(compareSelectedIdx==null)return;
    setCompareMarkupStrokes(strokes=>strokes.filter((_,i)=>i!==compareSelectedIdx));
    setCompareSelectedIdx(null);
  };

  // Photo overlay: capture/select an image and add it as a "photo" stroke
  const comparePhotoInputRef=useRef();
  const handleComparePhotoFile=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    e.target.value="";
    const img=new Image();
    img.onload=()=>{
      // Compress & scale to a reasonable size (max 1200px on the longest edge)
      const maxDim=1200;
      const scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      const cw=Math.round(img.width*scale),ch=Math.round(img.height*scale);
      const canvas=document.createElement("canvas");
      canvas.width=cw;canvas.height=ch;
      const ctx=canvas.getContext("2d");
      ctx.drawImage(img,0,0,cw,ch);
      const dataUrl=canvas.toDataURL("image/jpeg",0.82);
      setComparePendingPhoto({dataUrl,aspect:ch/cw});
      setCompareSelectedIdx(null);
    };
    img.onerror=()=>alert("Could not load image.");
    const reader=new FileReader();
    reader.onload=ev=>{img.src=ev.target.result;};
    reader.readAsDataURL(file);
  };

  // Resize the currently selected photo by a multiplier (clamped)
  const scaleComparePhoto=(mult)=>{
    if(compareSelectedIdx==null)return;
    setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>{
      if(i!==compareSelectedIdx||s.type!=="photo")return s;
      const nw=Math.max(5,Math.min(100,s.w*mult));
      const nh=(s.h/s.w)*nw;
      // Keep top-left pinned — user can drag to recenter
      return{...s,w:nw,h:nh};
    }));
  };

  const renderCompareMarkup=(strokes,interactive)=>strokes.map((s,i)=>{
    const isSel=interactive&&compareSelectedIdx===i;
    const hit=interactive?{style:{cursor:"move",pointerEvents:"visiblePainted"},onMouseDown:e=>onCompareStrokeDown(i,e),onTouchStart:e=>onCompareStrokeDown(i,e)}:{};
    const selStroke=isSel?"#5856d6":s.color;
    const selWidth=isSel?"0.9":"0.5";
    const dash=s.lineStyle==="dotted"?"0.8 0.6":undefined;
    if(s.type==="freehand"&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={selStroke} strokeWidth={selWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" {...hit}/>;
    }
    if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      const angle=Math.atan2(dy,dx),hl=1.8;
      return <g key={i} {...hit}><line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={selStroke} strokeWidth={selWidth} strokeDasharray={dash}/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle-0.45)} y2={s.end.y-hl*Math.sin(angle-0.45)} stroke={selStroke} strokeWidth={selWidth}/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle+0.45)} y2={s.end.y-hl*Math.sin(angle+0.45)} stroke={selStroke} strokeWidth={selWidth}/></g>;
    }
    if(s.type==="circle"&&s.start&&s.end){
      const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      if(rx<0.3&&ry<0.3)return null;
      return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={selStroke} strokeWidth={selWidth} fill="none" strokeDasharray={dash} {...hit}/>;
    }
    if(s.type==="rect"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w<0.3&&h<0.3)return null;
      return <rect key={i} x={x} y={y} width={w} height={h} stroke={selStroke} strokeWidth={selWidth} fill="none" strokeDasharray={dash} {...hit}/>;
    }
    if(s.type==="line"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.3)return null;
      return <line key={i} x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={selStroke} strokeWidth={selWidth} strokeDasharray={dash} {...hit}/>;
    }
    if(s.type==="dimension"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      const nx=-dy/len*1.2,ny=dx/len*1.2;
      const mx=(s.start.x+s.end.x)/2,my=(s.start.y+s.end.y)/2;
      const angle=Math.atan2(dy,dx)*180/Math.PI;
      const label=s.label||"";
      return <g key={i} {...hit}>
        <line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={selStroke} strokeWidth="0.2" strokeDasharray={dash}/>
        <line x1={s.start.x+nx} y1={s.start.y+ny} x2={s.start.x-nx} y2={s.start.y-ny} stroke={selStroke} strokeWidth={selWidth}/>
        <line x1={s.end.x+nx} y1={s.end.y+ny} x2={s.end.x-nx} y2={s.end.y-ny} stroke={selStroke} strokeWidth={selWidth}/>
        {label&&<text x={mx} y={my} fill={selStroke} fontSize="2.2" fontFamily="'Barlow Condensed',sans-serif" fontWeight="700" textAnchor="middle" dominantBaseline="central" transform={`rotate(${angle>90||angle<-90?angle+180:angle},${mx},${my})`} dy="-1">{label}</text>}
      </g>;
    }
    if(s.type==="text"&&s.pos&&s.text){
      const fs=s.fontSize||2.4;
      // Tight box — minimal padding so valign actually shifts the text visibly
      const padX=fs*0.15,padY=fs*0.08;
      const bw=s.text.length*fs*0.54+padX*2;
      const bh=fs+padY*2;
      const align=s.align||"left";
      const valign=s.valign||"bottom";
      let rectX,textAnchor="start";
      if(align==="center"){rectX=s.pos.x-bw/2;textAnchor="middle";}
      else if(align==="right"){rectX=s.pos.x-bw;textAnchor="end";}
      else rectX=s.pos.x;
      const textX=align==="center"?s.pos.x:(align==="right"?s.pos.x-padX:s.pos.x+padX);
      let rectY;
      if(valign==="top")rectY=s.pos.y;
      else if(valign==="middle")rectY=s.pos.y-bh/2;
      else rectY=s.pos.y-bh;
      const textY=rectY+fs+padY*0.85;
      return <g key={i} {...hit}>
        <rect x={rectX} y={rectY} width={bw} height={bh} rx={fs*0.25} fill="rgba(0,0,0,0.65)" stroke={isSel?"#5856d6":"none"} strokeWidth={isSel?"0.3":"0"}/>
        <text x={textX} y={textY} fontSize={fs} fontWeight="700" fill={s.color} fontFamily="Barlow Condensed, sans-serif" textAnchor={textAnchor}>{s.text}</text>
      </g>;
    }
    if(s.type==="cloud"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w<0.3&&h<0.3)return null;
      const arcsPerW=Math.max(4,Math.round(w/3)),arcsPerH=Math.max(4,Math.round(h/3));
      const dw=w/arcsPerW,dh=h/arcsPerH,r=Math.max(dw,dh)*0.55;
      let d="";
      for(let j=0;j<arcsPerW;j++){const cx=x+dw*j+dw/2;d+=`M${cx-dw/2},${y} A${r},${r} 0 0,1 ${cx+dw/2},${y} `;}
      for(let j=0;j<arcsPerH;j++){const cy=y+dh*j+dh/2;d+=`M${x+w},${cy-dh/2} A${r},${r} 0 0,1 ${x+w},${cy+dh/2} `;}
      for(let j=arcsPerW-1;j>=0;j--){const cx=x+dw*j+dw/2;d+=`M${cx+dw/2},${y+h} A${r},${r} 0 0,1 ${cx-dw/2},${y+h} `;}
      for(let j=arcsPerH-1;j>=0;j--){const cy=y+dh*j+dh/2;d+=`M${x},${cy+dh/2} A${r},${r} 0 0,1 ${x},${cy-dh/2} `;}
      return <path key={i} d={d} stroke={selStroke} strokeWidth={selWidth} fill="none" {...hit}/>;
    }
    if(s.type==="callout"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      const angle=Math.atan2(dy,dx),hl=1.8;
      const fs=s.fontSize||2.4;
      const text=s.text||"";
      const tw=text.length*fs*0.54;
      return <g key={i} {...hit}>
        <line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={selStroke} strokeWidth={selWidth} strokeDasharray={dash}/>
        <line x1={s.start.x} y1={s.start.y} x2={s.start.x+hl*Math.cos(angle-0.45)} y2={s.start.y+hl*Math.sin(angle-0.45)} stroke={selStroke} strokeWidth={selWidth}/>
        <line x1={s.start.x} y1={s.start.y} x2={s.start.x+hl*Math.cos(angle+0.45)} y2={s.start.y+hl*Math.sin(angle+0.45)} stroke={selStroke} strokeWidth={selWidth}/>
        {text&&<><rect x={s.end.x-0.3} y={s.end.y-fs-0.3} width={tw+0.6} height={fs+0.6} rx={fs*0.25} fill="rgba(0,0,0,0.65)" stroke={isSel?"#5856d6":"none"} strokeWidth={isSel?"0.3":"0"}/><text x={s.end.x} y={s.end.y} fontSize={fs} fontWeight="700" fill={s.color} fontFamily="Barlow Condensed, sans-serif">{text}</text></>}
      </g>;
    }
    if(s.type==="highlight"&&s.points&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={selStroke} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" {...hit}/>;
    }
    if(s.type==="polyline"&&s.points&&s.points.length>1){
      const pts=s.points.map(p=>`${p.x},${p.y}`).join(" ");
      if(s.closed)return <polygon key={i} points={pts} stroke={selStroke} strokeWidth={selWidth} fill="none" strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" {...hit}/>;
      return <polyline key={i} points={pts} stroke={selStroke} strokeWidth={selWidth} fill="none" strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" {...hit}/>;
    }
    if(s.type==="stamp"&&s.pos){
      const text=s.text||s.stampId||"STAMP";
      const fs=s.fontSize||2.4;
      const tw=text.length*fs*0.5;
      const pad=fs*0.4;
      const stampColor=s.stampId==="APPROVED"?"#34c759":s.stampId==="REJECTED"?"#ff3b30":s.stampId==="REVIEWED"?"#007aff":s.color||"#ff9500";
      return <g key={i} transform={`rotate(-15,${s.pos.x},${s.pos.y})`} {...hit}>
        <rect x={s.pos.x-tw/2-pad} y={s.pos.y-fs/2-pad} width={tw+pad*2} height={fs+pad*2} fill="none" stroke={isSel?"#5856d6":stampColor} strokeWidth={isSel?"0.5":"0.25"}/>
        <text x={s.pos.x} y={s.pos.y} fill={stampColor} fontSize={fs} fontFamily="Arial,sans-serif" fontWeight="700" textAnchor="middle" dominantBaseline="central" opacity="0.85">{text}</text>
      </g>;
    }
    if(s.type==="photo"&&s.pos&&s.dataUrl){
      return <g key={i} {...hit}>
        <image href={s.dataUrl} x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} preserveAspectRatio="xMidYMid meet"/>
        <rect x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} fill="none" stroke={isSel?"#5856d6":"rgba(255,255,255,0.85)"} strokeWidth={isSel?"0.5":"0.25"}/>
        {isSel&&<rect x={s.pos.x+s.w-1.5} y={s.pos.y+s.h-1.5} width={3} height={3} fill="#5856d6" stroke="#fff" strokeWidth="0.3" rx="0.5" style={{cursor:"nwse-resize"}}/>}
      </g>;
    }
    return null;
  });

  useEffect(()=>{
    if(!showCompare)return;
    const base=drawings.find(d=>d.id===compareBaseId);
    const target=drawings.find(d=>d.id===compareTargetId);
    if(!base||!target)return;
    if(!window.pdfjsLib||!compareBaseCanvasRef.current||!compareTargetCanvasRef.current)return;
    const pdfjsLib=window.pdfjsLib;
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    let cancelled=false;
    const renderPage=async(url,canvas,scale=2.5)=>{
      const doc=await pdfjsLib.getDocument(url).promise;
      try{
        const page=await doc.getPage(1);
        const viewport=page.getViewport({scale});
        canvas.width=viewport.width;canvas.height=viewport.height;
        await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      }finally{try{await doc.destroy();}catch{}}
    };
    setComparePreviewLoading(true);
    const baseUrl=DB.fileUrl("drawings",base.id,base.file);
    const targetUrl=DB.fileUrl("drawings",target.id,target.file);
    Promise.all([
      renderPage(baseUrl,compareBaseCanvasRef.current),
      renderPage(targetUrl,compareTargetCanvasRef.current)
    ]).then(()=>{
      if(cancelled)return;
      // Generate pixel-diff overlay: base=blue channel, revision=red channel
      const oc=compareOverlayCanvasRef.current;
      if(!oc)return;
      const bc=compareBaseCanvasRef.current;
      const tc=compareTargetCanvasRef.current;
      const w=Math.max(bc.width,tc.width);
      const h=Math.max(bc.height,tc.height);
      oc.width=w;oc.height=h;
      const ctx=oc.getContext("2d");
      // Draw base to temp canvas to get pixel data at uniform size
      const tmpB=document.createElement("canvas");tmpB.width=w;tmpB.height=h;
      const ctxB=tmpB.getContext("2d");ctxB.drawImage(bc,0,0,w,h);
      const tmpT=document.createElement("canvas");tmpT.width=w;tmpT.height=h;
      const ctxT=tmpT.getContext("2d");ctxT.drawImage(tc,0,0,w,h);
      const baseData=ctxB.getImageData(0,0,w,h);
      const targetData=ctxT.getImageData(0,0,w,h);
      const out=ctx.createImageData(w,h);
      const bd=baseData.data,td=targetData.data,od=out.data;
      const threshold=20;
      for(let i=0;i<bd.length;i+=4){
        // Convert to grayscale (inverted: higher = more ink/content)
        const bInk=255-Math.round(bd[i]*0.299+bd[i+1]*0.587+bd[i+2]*0.114);
        const tInk=255-Math.round(td[i]*0.299+td[i+1]*0.587+td[i+2]*0.114);
        const bHas=bInk>threshold;
        const tHas=tInk>threshold;
        if(bHas&&tHas){
          // Both have content — existing/unchanged — show as CYAN
          const ink=Math.max(bInk,tInk);
          od[i]=Math.max(0,255-ink*2);od[i+1]=Math.max(0,255-ink*0.3);od[i+2]=Math.max(0,255-ink*0.3);od[i+3]=255;
        }else if(tHas&&!bHas){
          // Only in revision — ADDED — show as MAGENTA
          od[i]=255;od[i+1]=Math.max(0,255-tInk*2);od[i+2]=255;od[i+3]=255;
        }else if(bHas&&!tHas){
          // Only in base — REMOVED/DEMOLISHED — show as YELLOW
          od[i]=255;od[i+1]=Math.max(0,255-bInk*0.3);od[i+2]=Math.max(0,255-bInk*2);od[i+3]=255;
        }else{
          // Empty in both — white background
          od[i]=255;od[i+1]=255;od[i+2]=255;od[i+3]=255;
        }
      }
      ctx.putImageData(out,0,0);
    }).catch(()=>{}).finally(()=>{if(!cancelled)setComparePreviewLoading(false);});
    return()=>{cancelled=true;};
  },[showCompare,compareBaseId,compareTargetId,drawings]);

  const downloadTextFile=(content,fileName,mime="text/plain;charset=utf-8")=>{
    const blob=new Blob([content],{type:mime});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  // Export Markups only
  const exportMarkupsCsv=()=>{
    const cc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const header=["Drawing","Type","Content","Color/Author","Position"];
    const rows=[];
    drawings.forEach(d=>{
      const notes=getDrawingNotes(d.id);const markups=getDrawingMarkup(d.id);
      notes.forEach(n=>rows.push([d.name,"NOTE",n.text,n.createdBy||"—",`(${Math.round(n.x)}%,${Math.round(n.y)}%)`]));
      markups.forEach(s=>rows.push([d.name,"MARKUP",s.type==="text"?s.text:s.type,s.color||"",""]));
    });
    if(!rows.length){alert("No markup annotations to export.");return;}
    const csv=[header,...rows].map(r=>r.map(cc).join(",")).join("\n");
    downloadTextFile(csv,`${fileTimestamp()}-markup_annotations.csv`,"text/csv;charset=utf-8");
  };

  const exportMarkupsPdf=async()=>{
    const markedUp=drawings.filter(d=>getDrawingMarkup(d.id).length>0||getDrawingNotes(d.id).length>0||allPins.some(p=>p.drawingId===d.id));
    if(!markedUp.length){alert("No markup annotations to export.");return;}
    const w=window.open("","_blank");if(!w){alert("Popup blocked.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-Markup Annotations</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:900px;margin:0 auto}h1{margin:0 0 4px;font-size:20px}.meta{font-size:12px;color:#444;margin-bottom:10px}.loading{padding:40px;text-align:center;color:#888;font-size:14px}</style></head><body><div class="loading">Rendering annotated drawings… please wait.</div></body></html>`);
    w.document.close();
    try{
      const rendered={};
      for(const d of markedUp){
        rendered[d.id]=await renderDrawingAnnotatedPages(d,defects,allPins);
      }
      const annotationListHtml=generateDrawingsEmailHTML(drawings,allPins,defects);
      let imagesHtml="";
      markedUp.forEach(d=>{
        const pages=rendered[d.id]||[];
        const notes=getDrawingNotes(d.id);const markups=getDrawingMarkup(d.id);
        const dPins=allPins.filter(p=>p.drawingId===d.id);
        const total=notes.length+markups.length+dPins.length;
        imagesHtml+=`<div style="margin:18px 0;page-break-inside:avoid"><h3 style="margin:0 0 6px;font-size:14px;color:#ff6b00">📐 ${sanitize(d.name)} <span style="font-weight:400;color:#888;font-size:11px">(${total} annotation${total===1?"":"s"})</span></h3>`;
        if(pages.length===0){
          imagesHtml+=`<div style="font-size:11px;color:#999;padding:10px;border:1px dashed #ddd;border-radius:6px">Drawing preview unavailable.</div>`;
        }else{
          pages.forEach(pg=>{
            imagesHtml+=`<div style="margin:6px 0;page-break-inside:avoid"><div style="font-size:10px;color:#888;margin-bottom:3px">Page ${pg.pageNum}</div><img src="${pg.dataUrl}" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/></div>`;
          });
        }
        imagesHtml+=`</div>`;
      });
      w.document.open();
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-Markup Annotations</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:900px;margin:0 auto}h1{margin:0 0 4px;font-size:20px}h2{margin:22px 0 10px;font-size:16px;border-bottom:2px solid #ddd;padding-bottom:4px}.meta{font-size:12px;color:#444;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f5f5f5;text-align:left}@media print{.no-print{display:none}}</style></head><body><h1>Markup Annotations Report</h1><div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")} | <b>Generated:</b> ${sanitize(new Date().toLocaleString())}</div><h2>📐 Annotated Drawings</h2>${imagesHtml}<h2>📋 Annotation Details</h2>${annotationListHtml}<button class="no-print" onclick="window.print()">Print / Save as PDF</button><script>window.onload=function(){setTimeout(function(){window.print();},400);};</script></body></html>`);
      w.document.close();
    }catch(e){
      console.error(e);
      try{w.close();}catch{}
      alert("Failed to render drawings: "+e.message);
    }
  };

  // Export Comparisons only
  const exportSavedComparisonsCsv=()=>{
    if(!savedComparisons.length){alert("No saved comparisons to export.");return;}
    const cc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const header=["Base","Revision","Added","Removed","AI Status","AI Report","Saved At","Saved By"];
    const rows=savedComparisons.map(sc=>[sc.baseName,sc.targetName,sc.totalAdded||0,sc.totalRemoved||0,sc.aiLocked?"APPROVED":"DRAFT",sc.aiReport?.replace(/\n/g," | ")||"",new Date(sc.savedAt).toLocaleString(),sc.savedBy||""]);
    const csv=[header,...rows].map(r=>r.map(cc).join(",")).join("\n");
    downloadTextFile(csv,`${fileTimestamp()}-saved_comparisons.csv`,"text/csv;charset=utf-8");
  };

  const exportSavedComparisonsPdf=()=>{
    if(!savedComparisons.length){alert("No saved comparisons to export.");return;}
    const html=generateComparisonsEmailHTML(savedComparisons);
    if(!html){alert("No saved comparisons to export.");return;}
    let imagesHtml="";
    savedComparisons.forEach(sc=>{
      imagesHtml+=`<div style="margin:18px 0;page-break-inside:avoid"><h3 style="margin:0 0 6px;font-size:14px;color:#5856d6">🔍 ${sanitize(sc.baseName)} → ${sanitize(sc.targetName)} <span style="font-weight:400;color:#888;font-size:11px">(+${sc.totalAdded||0} / -${sc.totalRemoved||0})</span></h3>`;
      if(sc.overlayThumb){
        imagesHtml+=`<img src="${sc.overlayThumb}" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/>`;
      }else{
        imagesHtml+=`<div style="font-size:11px;color:#999;padding:10px;border:1px dashed #ddd;border-radius:6px">No overlay preview saved for this comparison.</div>`;
      }
      imagesHtml+=`</div>`;
    });
    const w=window.open("","_blank");if(!w){alert("Popup blocked.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-Saved Comparisons</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:900px;margin:0 auto}h1{margin:0 0 4px;font-size:20px}h2{margin:22px 0 10px;font-size:16px;border-bottom:2px solid #ddd;padding-bottom:4px}.meta{font-size:12px;color:#444;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f5f5f5;text-align:left}@media print{.no-print{display:none}}</style></head><body><h1>Saved Comparisons Report</h1><div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")} | <b>Generated:</b> ${sanitize(new Date().toLocaleString())}</div><h2>🔍 Comparison Overlays</h2>${imagesHtml}<h2>📋 Comparison Details</h2>${html}<button class="no-print" onclick="window.print()">Print / Save as PDF</button><script>window.onload=function(){setTimeout(function(){window.print();},400);};</script></body></html>`);
    w.document.close();
  };

  // Export All — combined report of drawings + saved comparisons
  const exportAll=()=>{
    const stamp=fileTimestamp();
    const cc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const header=["Section","Type","Title","Detail","Severity/Status","Drawing","Timestamp","Project","Company"];
    const rows=[];
    const proj=currentProject?.name||"";
    const comp=company?.companyName||"";

    // Drawing annotations (notes + markups per drawing)
    drawings.forEach(d=>{
      const notes=getDrawingNotes(d.id);
      const markups=getDrawingMarkup(d.id);
      const dPins=allPins.filter(p=>p.drawingId===d.id);
      dPins.forEach(p=>{
        const df=defects.find(x=>x.id===p.entryId);
        rows.push(["DRAWING",df?"PIN":"PIN",df?.title||"Linked entry",df?.location||"",df?`${df.severity} · ${df.status}`:"—",d.name,"",proj,comp]);
      });
      notes.forEach(n=>rows.push(["DRAWING","NOTE",n.text,`By ${n.createdBy||"—"}`,`(${Math.round(n.x)}%,${Math.round(n.y)}%)`,d.name,n.createdAt?new Date(n.createdAt).toISOString():"",proj,comp]));
      markups.forEach(s=>rows.push(["DRAWING","MARKUP",s.type==="text"?s.text:`${s.type}`,s.color||"","",d.name,"",proj,comp]));
    });

    // Saved comparisons
    savedComparisons.forEach(sc=>{
      rows.push(["COMPARISON","SUMMARY",`${sc.baseName} → ${sc.targetName}`,`+${sc.totalAdded} / -${sc.totalRemoved}`,sc.aiLocked?"APPROVED":"DRAFT","",new Date(sc.savedAt).toISOString(),proj,comp]);
      if(sc.aiReport)rows.push(["COMPARISON","AI_REPORT",sc.aiReport.replace(/\n/g," | "),"","","",new Date(sc.savedAt).toISOString(),proj,comp]);
      (sc.markups||[]).filter(s=>s.type==="text"&&s.text).forEach(s=>rows.push(["COMPARISON","MARKUP",s.text,s.color||"","","",new Date(sc.savedAt).toISOString(),proj,comp]));
      (sc.auditLog||[]).forEach(e=>rows.push(["COMPARISON","AUDIT",`${e.action.toUpperCase()} by ${e.by}`,e.reason||"","","",new Date(e.at).toISOString(),proj,comp]));
      (sc.added||[]).forEach(l=>rows.push(["COMPARISON","ADDED",l?.text||l,"","",`${sc.baseName}→${sc.targetName}`,new Date(sc.savedAt).toISOString(),proj,comp]));
      (sc.removed||[]).forEach(l=>rows.push(["COMPARISON","REMOVED",l?.text||l,"","",`${sc.baseName}→${sc.targetName}`,new Date(sc.savedAt).toISOString(),proj,comp]));
    });

    if(rows.length===0){alert("No annotations or comparisons to export.");return;}

    const csv=[header,...rows].map(r=>r.map(cc).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${stamp}-${(proj||"export").replace(/\W+/g,"_")}_all_annotations.csv`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  // Export All PDF — combined printable report of drawings + saved comparisons
  const exportAllPdf=async()=>{
    const stamp=new Date().toLocaleString();
    const proj=sanitize(currentProject?.name||"—");
    const comp=sanitize(company?.companyName||"—");

    // Open placeholder window immediately so popup-blockers see a user-gesture
    const w=window.open("","_blank");
    if(!w){alert("Popup blocked. Please allow popups to export PDF.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Project Annotations Report</title></head><body style="font-family:Arial,sans-serif;padding:40px;text-align:center;color:#888">Rendering annotated drawings and comparison overlays… please wait.</body></html>`);
    w.document.close();

    // Pre-render annotated pages for every drawing that has any annotation
    const renderedDrawings={};
    try{
      for(const d of drawings){
        const hasAny=(getDrawingNotes(d.id).length+getDrawingMarkup(d.id).length+allPins.filter(p=>p.drawingId===d.id).length)>0;
        if(hasAny){
          renderedDrawings[d.id]=await renderDrawingAnnotatedPages(d,defects,allPins);
        }
      }
    }catch(e){console.warn("Drawing render error",e);}

    // Build drawing sections
    let drawingSections="";
    drawings.forEach(d=>{
      const notes=getDrawingNotes(d.id);
      const markups=getDrawingMarkup(d.id);
      const dPins=allPins.filter(p=>p.drawingId===d.id);
      const pinRows=dPins.map((p,i)=>{
        const df=defects.find(x=>x.id===p.entryId);
        return`<tr><td>${i+1}</td><td style="color:#ff3b30;font-weight:700">PIN</td><td>${sanitize(df?.title||"Linked entry")}</td><td>${sanitize(df?.severity||"—")}</td><td>${sanitize(df?.status||"—")}</td></tr>`;
      }).join("");
      const noteRows=notes.map((n,i)=>`<tr><td>${dPins.length+i+1}</td><td style="color:#5856d6;font-weight:700">NOTE</td><td>${sanitize(n.text)}</td><td>By ${sanitize(n.createdBy||"—")}</td><td>(${Math.round(n.x)}%, ${Math.round(n.y)}%)</td></tr>`).join("");
      const markupRows=markups.map((s,i)=>`<tr><td>${dPins.length+notes.length+i+1}</td><td style="color:#ff6b00;font-weight:700">MARKUP</td><td>${sanitize(s.type==="text"?s.text:s.type)}</td><td>${sanitize(s.color||"")}</td><td>—</td></tr>`).join("");
      const total=dPins.length+notes.length+markups.length;
      if(total>0){
        const pages=renderedDrawings[d.id]||[];
        const pagesHtml=pages.length?pages.map(pg=>`<div style="margin:6px 0;page-break-inside:avoid"><div style="font-size:10px;color:#888;margin-bottom:3px">Page ${pg.pageNum}</div><img src="${pg.dataUrl}" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/></div>`).join(""):`<div style="font-size:11px;color:#999;padding:8px;border:1px dashed #ddd;border-radius:6px;margin:6px 0">Drawing preview unavailable.</div>`;
        drawingSections+=`<div style="margin-bottom:18px;page-break-inside:avoid"><h3 style="margin:0 0 6px;font-size:14px;color:#ff6b00">📐 ${sanitize(d.name)} <span style="font-weight:400;color:#888;font-size:11px">(${total} item${total>1?"s":""})</span></h3>${pagesHtml}<table><thead><tr><th style="width:36px">#</th><th>Type</th><th>Title / Content</th><th>Category</th><th>Status / Location</th></tr></thead><tbody>${pinRows}${noteRows}${markupRows}</tbody></table></div>`;
      }
    });

    // Build comparison sections
    let compareSections="";
    savedComparisons.forEach(sc=>{
      const scStamp=new Date(sc.savedAt).toLocaleString();
      const addedRows=(sc.added||[]).map((l,i)=>`<tr><td>${i+1}</td><td>${sanitize(l?.text||l)}</td></tr>`).join("")||`<tr><td colspan="2" style="color:#999;text-align:center">No added lines</td></tr>`;
      const removedRows=(sc.removed||[]).map((l,i)=>`<tr><td>${i+1}</td><td>${sanitize(l?.text||l)}</td></tr>`).join("")||`<tr><td colspan="2" style="color:#999;text-align:center">No removed lines</td></tr>`;
      const aiSection=sc.aiReport?`<div style="margin:8px 0;background:#f5f3ff;border:1px solid #d8d2ff;border-radius:6px;padding:8px;font-size:11px;white-space:pre-wrap">${sanitize(sc.aiReport)}</div><div style="font-size:10px;color:${sc.aiLocked?"#1a7a35":"#666"};margin-bottom:6px"><b>Status:</b> ${sc.aiLocked?"LOCKED / APPROVED":"DRAFT"}</div>`:"";
      const auditSection=(sc.auditLog||[]).length?`<div style="font-size:10px;border:1px solid #ddd;border-radius:6px;padding:6px;background:#fafafa;margin:6px 0"><b>Audit Trail</b>${(sc.auditLog||[]).map(e=>`<div style="margin:2px 0;color:${e.action==="lock"?"#1a7a35":"#b36b00"}"><b>${e.action.toUpperCase()}</b> by ${sanitize(e.by)} at ${sanitize(new Date(e.at).toLocaleString())}${e.reason?` — <i>${sanitize(e.reason)}</i>`:""}</div>`).join("")}</div>`:"";
      const markupSection=(sc.markups||[]).length?`<div style="font-size:10px;color:#ff6b00;margin:4px 0">✏ ${(sc.markups||[]).length} markup annotation(s): ${(sc.markups||[]).filter(s=>s.type==="text").map(s=>`"${sanitize(s.text)}"`).join(", ")||"(no text)"}</div>`:"";
      const overlayHtml=sc.overlayThumb?`<div style="margin:6px 0;page-break-inside:avoid"><img src="${sc.overlayThumb}" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/></div>`:"";
      compareSections+=`<div style="margin-bottom:18px;page-break-inside:avoid"><h3 style="margin:0 0 6px;font-size:14px;color:#5856d6">🔍 ${sanitize(sc.baseName)} → ${sanitize(sc.targetName)} <span style="font-weight:400;color:#888;font-size:11px">(${scStamp})</span></h3>${overlayHtml}<div style="display:flex;gap:8px;margin:6px 0"><div style="flex:1;border:1px solid #ff3b30;border-radius:6px;padding:6px;background:#fff3f2"><b>Added</b><div style="font-size:18px;font-weight:bold">${sc.totalAdded||0}</div></div><div style="flex:1;border:1px solid #34c759;border-radius:6px;padding:6px;background:#f0fff5"><b>Removed</b><div style="font-size:18px;font-weight:bold">${sc.totalRemoved||0}</div></div></div>${aiSection}${auditSection}${markupSection}<h4 style="color:#ff3b30;margin:8px 0 4px;font-size:12px">Added Lines</h4><table><thead><tr><th style="width:36px">#</th><th>Line</th></tr></thead><tbody>${addedRows}</tbody></table><h4 style="color:#34c759;margin:8px 0 4px;font-size:12px">Removed Lines</h4><table><thead><tr><th style="width:36px">#</th><th>Line</th></tr></thead><tbody>${removedRows}</tbody></table></div>`;
    });

    if(!drawingSections&&!compareSections){try{w.close();}catch{}alert("No annotations or comparisons to export.");return;}

    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-${sanitize(currentProject?.name||"export")}_all_annotations</title><style>
      body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:900px;margin:0 auto}
      h1{margin:0 0 4px;font-size:22px} h2{margin:22px 0 10px;font-size:17px;border-bottom:2px solid #ddd;padding-bottom:4px}
      h3{page-break-after:avoid} h4{page-break-after:avoid}
      .meta{font-size:12px;color:#444;margin-bottom:4px}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:6px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}
      th{background:#f5f5f5;text-align:left}
      @media print{.no-print{display:none}}
    </style></head><body>
      <h1>Project Annotations Report</h1>
      <div class="meta"><b>Project:</b> ${proj} | <b>Company:</b> ${comp} | <b>Generated:</b> ${sanitize(stamp)}</div>
      <div class="meta"><b>Drawings:</b> ${drawings.length} | <b>Saved Comparisons:</b> ${savedComparisons.length}</div>
      ${drawingSections?`<h2>📐 Drawing Annotations</h2>${drawingSections}`:""}
      ${compareSections?`<h2>🔍 Saved Comparisons</h2>${compareSections}`:""}
      <div class="no-print" style="margin-top:16px;font-size:12px;color:#444">Use your browser destination "Save as PDF" when print dialog appears.</div>
      <script>window.onload=function(){setTimeout(function(){window.print();},250);};</script>
    </body></html>`);
    w.document.close();
  };

  const csvCell=v=>`"${String(v??"").replace(/"/g,'""')}"`;

  const exportCompareCsv=()=>{
    if(!compareRes)return;
    const stamp=new Date(compareRes.generatedAt||Date.now()).toISOString();
    const header=["Type","Line","Base Version","Revision Version","Generated At","Project","Remarks"];
    const rows=[];
    if(compareAiReport){
      rows.push(["AI_REPORT",compareAiReport.replace(/\n/g," | "),compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
      rows.push(["AI_APPROVAL",compareAiLocked?"LOCKED":"DRAFT",`By: ${compareAiApprovedBy||""} At: ${compareAiApprovedAt?new Date(compareAiApprovedAt).toISOString():""}`,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    }
    compareAuditLog.forEach(e=>rows.push(["AUDIT",`${e.action.toUpperCase()} by ${e.by} at ${new Date(e.at).toISOString()}${e.reason?" — Reason: "+e.reason:""}`,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    compareMarkupStrokes.filter(s=>s.type==="text"&&s.text).forEach(s=>rows.push(["MARKUP",s.text,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    if(compareMarkupStrokes.length>0)rows.push(["MARKUP_COUNT",`${compareMarkupStrokes.length} annotation(s): ${compareMarkupStrokes.filter(s=>s.type==="text").length} text, ${compareMarkupStrokes.filter(s=>s.type==="freehand").length} freehand, ${compareMarkupStrokes.filter(s=>s.type==="arrow").length} arrow, ${compareMarkupStrokes.filter(s=>s.type==="circle").length} circle`,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    compareRes.added.forEach((line,i)=>{const e=diffEdits[`added_${i}`];rows.push(["ADDED",e?.name||line?.text||line,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",e?.remark||""]);});
    compareRes.removed.forEach((line,i)=>{const e=diffEdits[`removed_${i}`];rows.push(["REMOVED",e?.name||line?.text||line,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",e?.remark||""]);});
    if(rows.length===0)rows.push(["NO_DIFF","No added/removed lines detected",compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    const csv=[header,...rows].map(r=>r.map(csvCell).join(",")).join("\n");
    const fn=`${fileTimestamp()}-compare_${(compareRes.baseName||"base").replace(/\W+/g,"_")}_to_${(compareRes.targetName||"revision").replace(/\W+/g,"_")}.csv`;
    downloadTextFile(csv,fn,"text/csv;charset=utf-8");
  };

  const exportComparePdf=()=>{
    if(!compareRes)return;
    const addedHtml=(compareRes.added.length?compareRes.added:["No added lines detected."]).map((l,i)=>{const e=diffEdits[`added_${i}`];const txt=e?.name?`<b>${sanitize(e.name)}</b> <span style="color:#999;font-size:10px">(was: ${sanitize(l?.text||l)})</span>`:sanitize(l?.text||l);return`<tr><td>${i+1}</td><td>${txt}${e?.remark?`<div style="color:#666;font-size:10px;margin-top:2px;font-style:italic">💬 ${sanitize(e.remark)}</div>`:""}</td></tr>`;}).join("");
    const removedHtml=(compareRes.removed.length?compareRes.removed:["No removed lines detected."]).map((l,i)=>{const e=diffEdits[`removed_${i}`];const txt=e?.name?`<b>${sanitize(e.name)}</b> <span style="color:#999;font-size:10px">(was: ${sanitize(l?.text||l)})</span>`:sanitize(l?.text||l);return`<tr><td>${i+1}</td><td>${txt}${e?.remark?`<div style="color:#666;font-size:10px;margin-top:2px;font-style:italic">💬 ${sanitize(e.remark)}</div>`:""}</td></tr>`;}).join("");
    const stamp=new Date(compareRes.generatedAt||Date.now());
    const aiApprovalHtml=compareAiReport?`<div style="margin:8px 0 0;font-size:11px;color:${compareAiLocked?"#1a7a35":"#666"};background:${compareAiLocked?"#eefcf1":"#f7f7f7"};border:1px solid ${compareAiLocked?"#9cd8ad":"#ddd"};border-radius:6px;padding:8px"><b>AI Report Status:</b> ${compareAiLocked?"LOCKED":"DRAFT"}${compareAiApprovedBy?` | <b>Approved by:</b> ${sanitize(compareAiApprovedBy)}`:""}${compareAiApprovedAt?` | <b>Approved at:</b> ${sanitize(new Date(compareAiApprovedAt).toLocaleString())}`:""}</div>`:"";
    const auditHtml=compareAuditLog.length?`<div style="margin:8px 0 0;font-size:10px;border:1px solid #ddd;border-radius:6px;padding:8px;background:#fafafa"><b>Audit Trail</b>${compareAuditLog.map(e=>`<div style="margin:3px 0;color:${e.action==="lock"?"#1a7a35":"#b36b00"}"><b>${e.action.toUpperCase()}</b> by ${sanitize(e.by)} at ${sanitize(new Date(e.at).toLocaleString())}${e.reason&&e.action==="unlock"?` — <i>${sanitize(e.reason)}</i>`:""}</div>`).join("")}</div>`:"";
    const markupHtml=compareMarkupStrokes.length?`<h2 style="color:#ff6b00">Markup Annotations (${compareMarkupStrokes.length})</h2><div style="font-size:11px;border:1px solid #ffd6b8;border-radius:6px;padding:8px;background:#fff8f3">${compareMarkupStrokes.filter(s=>s.type==="text"&&s.text).map(s=>`<div style="margin:2px 0">📝 ${sanitize(s.text)}</div>`).join("")||"<i>No text annotations</i>"}<div style="margin-top:4px;color:#999;font-size:10px">${compareMarkupStrokes.filter(s=>s.type==="freehand").length} freehand, ${compareMarkupStrokes.filter(s=>s.type==="arrow").length} arrow, ${compareMarkupStrokes.filter(s=>s.type==="circle").length} circle</div></div>`:"";
    const aiHtml=compareAiReport?`<h2 style="color:#5856d6">AI-Supported Analysis</h2><div style="white-space:pre-wrap;font-size:12px;line-height:1.45;background:#f5f3ff;border:1px solid #d8d2ff;border-radius:8px;padding:10px">${sanitize(compareAiReport)}</div>${aiApprovalHtml}${auditHtml}`:"";
    const w=window.open("","_blank");
    if(!w){alert("Popup blocked. Please allow popups to export PDF.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-Drawing Comparison Report</title><style>
      body{font-family:Arial,sans-serif;padding:22px;color:#111}
      h1{margin:0 0 4px;font-size:22px} h2{margin:20px 0 8px;font-size:16px}
      .meta{font-size:12px;color:#444;margin-bottom:6px}
      .cards{display:flex;gap:10px;margin:10px 0 14px}
      .card{flex:1;border-radius:8px;padding:10px;border:1px solid #ddd}
      .add{border-color:#ff3b30;background:#fff3f2}.rem{border-color:#34c759;background:#f0fff5}
      table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}
      th{background:#f5f5f5;text-align:left}
      @media print {.no-print{display:none}}
    </style></head><body>
      <h1>Drawing Revision Comparison</h1>
      <div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")}</div>
      <div class="meta"><b>Base:</b> ${sanitize(compareRes.baseName)} | <b>Revision:</b> ${sanitize(compareRes.targetName)}</div>
      <div class="meta"><b>Generated:</b> ${sanitize(stamp.toLocaleString())}</div>
      <div class="cards">
        <div class="card add"><div><b>Added lines (Red)</b></div><div style="font-size:22px;font-weight:bold">${compareRes.totalAdded}</div></div>
        <div class="card rem"><div><b>Removed lines (Green)</b></div><div style="font-size:22px;font-weight:bold">${compareRes.totalRemoved}</div></div>
      </div>
      <h2 style="color:#ff3b30">Added Lines</h2>
      <table><thead><tr><th style="width:44px">#</th><th>Line</th></tr></thead><tbody>${addedHtml}</tbody></table>
      <h2 style="color:#34c759">Removed Lines</h2>
      <table><thead><tr><th style="width:44px">#</th><th>Line</th></tr></thead><tbody>${removedHtml}</tbody></table>
      ${aiHtml}
      ${markupHtml}
      <div class="no-print" style="margin-top:16px;font-size:12px;color:#444">Use your browser destination "Save as PDF" when print dialog appears.</div>
      <script>window.onload=function(){setTimeout(function(){window.print();},250);};</script>
    </body></html>`);
    w.document.close();
  };

  const closeViewerAndRefreshPins=()=>{
    setViewing(null);
  };

  if(viewing)return <DrawingViewer drawing={viewing} onClose={closeViewerAndRefreshPins} company={company} currentProject={currentProject} member={member} defects={defects} onSaveEntry={onSaveEntry}/>;

  return(
    <div style={embedded?{background:"#f0ede8",minHeight:"100%"}:{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      {!embedded&&<SettingsBack onClose={onClose} title={t("drawings.tag_compare")}/>}
      <div style={{padding:20}}>
        {embedded&&<div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:14}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>{t("drawings.tag_compare")}</div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>Upload, pin, overlay photos and compare</div>
        </div>}

        {/* Sub-mode toggle bar */}
        <div style={{display:"flex",gap:6,padding:4,background:"rgba(0,0,0,0.05)",borderRadius:12,marginBottom:14}}>
          {[
            {id:"drawing",icon:"blueprint",label:t("maps.submode_drawing")},
            {id:"map",icon:"pin",label:t("maps.submode_map")},
          ].map(m=>(
            <button key={m.id} onClick={()=>{setSubMode(m.id);setShowCompare(false);}} style={{flex:1,padding:"9px 10px",borderRadius:9,border:"none",background:subMode===m.id?"#fff":"transparent",color:subMode===m.id?"#1a1a1a":"rgba(0,0,0,0.55)",boxShadow:subMode===m.id?"0 1px 3px rgba(0,0,0,0.08)":"none",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,whiteSpace:"nowrap"}}>
              <DdIcon name={m.icon} size={16}/>{m.label}
            </button>
          ))}
        </div>

        {subMode==="map"?(
          <MapPanel currentProject={currentProject} member={member} defects={defects} onSaveEntry={onSaveEntry} company={company} onSnapped={(rec)=>{setDrawings(prev=>[rec,...prev]);setSubMode("drawing");setViewing(rec);}}/>
        ):(<>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf,.pdf,.tif,.tiff" onChange={uploadDrawing} style={{display:"none"}}/>
        <input ref={convertRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={convertJpgsToPdf} style={{display:"none"}}/>
        {converting&&convertProgress&&(
          <div style={{background:"rgba(52,199,89,0.12)",border:"1px solid rgba(52,199,89,0.35)",borderRadius:10,padding:"10px 12px",marginBottom:12,fontFamily:"'Barlow Condensed',sans-serif"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,fontSize:12,color:"#1a6a33",fontWeight:700}}>
              <Spin size={14}/>
              <span style={{flex:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                {convertProgress.totalFiles>1?`[${convertProgress.fileIdx}/${convertProgress.totalFiles}] `:""}{convertProgress.label}
              </span>
              <span style={{color:"#1a6a33",fontWeight:800,fontSize:12,flexShrink:0}}>{convertProgress.pct}%</span>
              <button onClick={()=>{convertCancelRef.current=true;}} disabled={convertCancelRef.current} title="Stop converting — finishes the current file, then skips the rest" style={{background:convertCancelRef.current?"rgba(255,59,48,0.15)":"rgba(255,59,48,0.12)",border:"1px solid rgba(255,59,48,0.4)",borderRadius:8,padding:"3px 10px",color:"#c0392b",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:convertCancelRef.current?"wait":"pointer",flexShrink:0}}>{convertCancelRef.current?"STOPPING…":"✕ STOP"}</button>
            </div>
            <div style={{height:6,background:"rgba(52,160,80,0.18)",borderRadius:3,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${convertProgress.pct}%`,background:"linear-gradient(90deg,#34c759,#2a9a4a)",borderRadius:3,transition:"width 0.25s ease"}}/>
            </div>
            <div style={{fontSize:10,color:"rgba(26,106,51,0.65)",marginTop:4}}>Tracing is the long step — on very large images it can take 30-60 seconds. STOP will abort after the current file finishes.</div>
          </div>
        )}

        {/* Action bar — four equal-width buttons, spread across the row so
            labels breathe and the right edge stays inside the viewport on
            narrow phones. */}
        <div style={{display:"flex",alignItems:"stretch",gap:6,marginBottom:16}}>
          {canUpload&&(
            <button onClick={()=>fileRef.current?.click()} disabled={uploading} title="Upload" style={{flex:1,minWidth:0,borderRadius:10,background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.12)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 10px",gap:5}}>
              {uploading?<Spin size={16}/>:<><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 16V3m0 0L7 8m5-5l5 5" stroke="rgba(0,0,0,0.55)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" stroke="rgba(0,0,0,0.55)" strokeWidth="1.8" strokeLinecap="round"/></svg><span style={{fontSize:12,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:"rgba(0,0,0,0.55)"}}>Upload</span></>}
            </button>
          )}
          {canUpload&&(
            <button onClick={()=>convertRef.current?.click()} disabled={converting} title="Convert JPG sketches to vector PDF drawings (single or batch)" style={{flex:1,minWidth:0,borderRadius:10,background:"rgba(52,199,89,0.08)",border:"1px solid rgba(52,199,89,0.3)",cursor:converting?"wait":"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 10px",gap:5}}>
              {converting?<Spin size={16}/>:<><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h6l2-3h6a2 2 0 012 2v13a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2z" stroke="rgba(52,160,80,0.85)" strokeWidth="1.6" strokeLinejoin="round"/><path d="M9 13l2 2 4-4" stroke="rgba(52,160,80,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg><span style={{fontSize:12,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:"rgba(52,160,80,0.9)"}}>Convert</span></>}
            </button>
          )}
          <div style={{flex:1,minWidth:0,position:"relative"}} onMouseEnter={()=>{clearTimeout(diffMenuTimer.current);setShowDiffMenu(true);}} onMouseLeave={()=>{diffMenuTimer.current=setTimeout(()=>setShowDiffMenu(false),250);}}>
            <button onClick={()=>setShowDiffMenu(v=>!v)} title={t("export.diff_compare")} style={{width:"100%",borderRadius:10,background:"rgba(88,86,214,0.08)",border:"1px solid rgba(88,86,214,0.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 10px",gap:5}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="18" rx="1.5" stroke="rgba(88,86,214,0.8)" strokeWidth="1.8"/><rect x="13" y="3" width="8" height="18" rx="1.5" stroke="rgba(88,86,214,0.8)" strokeWidth="1.8"/><path d="M7 8h0M7 12h0M17 8h0M17 12h0" stroke="rgba(88,86,214,0.8)" strokeWidth="2.2" strokeLinecap="round"/></svg>
              <span style={{fontSize:12,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:"rgba(88,86,214,0.85)"}}>{t("export.diff")}</span>
            </button>
            {showDiffMenu&&<div onMouseEnter={()=>clearTimeout(diffMenuTimer.current)} onMouseLeave={()=>{diffMenuTimer.current=setTimeout(()=>setShowDiffMenu(false),250);}} style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,overflow:"hidden",zIndex:100,minWidth:200}}>
              <div style={{padding:"6px 12px 3px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("export.compare_header")}</div>
              <button onClick={()=>{setShowDiffMenu(false);if(pdfDrawings.length>=2)openCompare();else alert("Upload at least 2 PDF drawings to compare.");}} disabled={pdfDrawings.length<2} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:pdfDrawings.length>=2?"pointer":"not-allowed",color:pdfDrawings.length>=2?"#d8d2ff":"rgba(216,210,255,0.3)",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("export.single_compare")} <span style={{color:"rgba(255,255,255,0.35)",fontWeight:400}}>{t("export.single_compare_desc")}</span></button>
              <button onClick={()=>{setShowDiffMenu(false);setShowBatchCompare(true);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#d8d2ff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("export.batch_compare")} <span style={{color:"rgba(255,255,255,0.35)",fontWeight:400}}>{t("export.batch_compare_desc")}</span></button>
            </div>}
          </div>
          <div style={{flex:1,minWidth:0,position:"relative"}} onMouseEnter={()=>{clearTimeout(dnMenuTimer.current);setShowDnMenu(true);}} onMouseLeave={()=>{dnMenuTimer.current=setTimeout(()=>setShowDnMenu(false),250);}}>
            <button onClick={()=>setShowDnMenu(v=>!v)} title="Download" style={{width:"100%",borderRadius:10,background:"rgba(52,170,220,0.1)",border:"1px solid rgba(52,170,220,0.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 10px",gap:5}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="rgba(52,170,220,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="rgba(52,170,220,0.85)" strokeWidth="1.8" strokeLinecap="round"/></svg>
              <span style={{fontSize:12,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:"rgba(52,170,220,0.9)"}}>Download</span>
            </button>
            {showDnMenu&&<div onMouseEnter={()=>clearTimeout(dnMenuTimer.current)} onMouseLeave={()=>{dnMenuTimer.current=setTimeout(()=>setShowDnMenu(false),250);}} style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,overflow:"hidden",zIndex:100,minWidth:180}}>
              <div style={{padding:"6px 12px 3px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("export.markups_header")}</div>
              <button onClick={()=>{exportMarkupsCsv();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#ffb48a",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("export.markup_csv")}</button>
              <button onClick={()=>{exportMarkupsPdf();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#ffb48a",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>{t("export.markup_pdf")}</button>
              <div style={{padding:"6px 12px 3px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("compare.title")}</div>
              <button onClick={()=>{exportSavedComparisonsCsv();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#d8d2ff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("export.compare_csv")}</button>
              <button onClick={()=>{exportSavedComparisonsPdf();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#d8d2ff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>{t("export.compare_pdf")}</button>
              <div style={{padding:"6px 12px 3px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("export.all_header")}</div>
              <button onClick={()=>{exportAll();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#7fd7ff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{t("export.all_csv")}</button>
              <button onClick={()=>{exportAllPdf();setShowDnMenu(false);}} style={{width:"100%",textAlign:"left",padding:"6px 12px",background:"none",border:"none",cursor:"pointer",color:"#7fd7ff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>{t("export.all_pdf")}</button>
              <button onClick={async()=>{setShowDnMenu(false);exportAll();await exportAllPdf();}} style={{width:"100%",textAlign:"left",padding:"8px 12px",background:"rgba(48,209,88,0.08)",border:"none",cursor:"pointer",color:"#6ee7a0",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800}}>{t("export.all_in_one")}</button>
            </div>}
          </div>
        </div>

        {/* Section counters bar */}
        {(()=>{
          const markedUpDrawings=drawings.filter(d=>getDrawingMarkup(d.id).length>0||getDrawingNotes(d.id).length>0);
          return(
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <div style={{background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,padding:"6px 12px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"rgba(0,0,0,0.5)"}}>📐 {t("drawings.uploaded_drawings")} ({drawings.length})</div>
              {markedUpDrawings.length>0&&<div style={{background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10,padding:"6px 12px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"#ff6b00"}}>✏ {t("drawings.saved_markup_drawings")} ({markedUpDrawings.length})</div>}
              {savedComparisons.length>0&&<div style={{background:"rgba(88,86,214,0.08)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"6px 12px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"#5856d6"}}>🔍 {t("compare.saved_comparisons")} ({savedComparisons.length})</div>}
            </div>
          );
        })()}

        {/* Saved comparisons */}
        {savedComparisons.length>0&&(
          <div style={{marginBottom:16}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>{t("compare.saved_comparisons")} ({savedComparisons.length})</div>
            {savedComparisons.map(sc=>(
              <div key={sc.id} style={{background:"#fff",borderRadius:12,padding:0,marginBottom:10,overflow:"hidden",border:"1px solid rgba(0,0,0,0.08)"}}>
                {sc.overlayThumb&&(
                  <div style={{position:"relative",cursor:"pointer"}} onClick={()=>loadSavedComparison(sc)}>
                    <img src={sc.overlayThumb} alt="Comparison overlay" style={{width:"100%",display:"block",objectFit:"contain",background:"#f8f8f6"}}/>
                    <div style={{position:"absolute",left:6,top:6,display:"flex",gap:4}}>
                      <div style={{background:"rgba(0,0,0,0.7)",borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,color:"#ff8a8a",fontFamily:"'Barlow Condensed',sans-serif"}}>+{sc.totalAdded}</div>
                      <div style={{background:"rgba(0,0,0,0.7)",borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,color:"#8ab4ff",fontFamily:"'Barlow Condensed',sans-serif"}}>-{sc.totalRemoved}</div>
                    </div>
                    {sc.aiLocked&&<div style={{position:"absolute",right:6,top:6,background:"rgba(52,199,89,0.85)",borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>APPROVED</div>}
                  </div>
                )}
                <div style={{padding:"10px 12px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#1a1a1a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sc.baseName} → {sc.targetName}</div>
                      <div style={{fontSize:10,color:"rgba(0,0,0,0.4)"}}>{new Date(sc.savedAt).toLocaleString()} · By {sc.savedBy||"—"}</div>
                    </div>
                    <button onClick={()=>loadSavedComparison(sc)} style={{background:"rgba(88,86,214,0.12)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:8,padding:"5px 10px",color:"#5856d6",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>OPEN</button>
                    <button onClick={()=>deleteSavedComparison(sc.id)} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"5px 10px",color:"#ff3b30",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.delete")}</button>
                  </div>
                  <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                    {sc.markups?.length>0&&<span style={{fontSize:9,fontWeight:700,color:"#ff6b00",background:"rgba(255,107,0,0.12)",border:"1px solid rgba(255,107,0,0.25)",borderRadius:8,padding:"2px 6px",fontFamily:"'Barlow Condensed',sans-serif"}}>✏ {sc.markups.length}</span>}
                    {sc.aiReport&&<span style={{fontSize:9,fontWeight:700,color:"#5856d6",background:"rgba(88,86,214,0.12)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:8,padding:"2px 6px",fontFamily:"'Barlow Condensed',sans-serif"}}>AI Report</span>}
                    {sc.auditLog?.length>0&&<span style={{fontSize:9,fontWeight:700,color:"rgba(0,0,0,0.4)",background:"rgba(0,0,0,0.05)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:8,padding:"2px 6px",fontFamily:"'Barlow Condensed',sans-serif"}}>{sc.auditLog.length} audit</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {loading&&<div style={{textAlign:"center",padding:40}}><Spin size={20}/></div>}

        {!loading&&drawings.length===0&&(
          <div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"50px 0"}}>
            <div style={{fontSize:32,marginBottom:8}}>📐</div>
            <div style={{fontSize:14}}>No drawings yet</div>
            {canUpload&&<div style={{fontSize:12,marginTop:4}}>Upload a drawing to get started</div>}
            {canUpload&&(
              <button onClick={loadSampleDrawings} disabled={loadingSamples} style={{marginTop:14,background:"rgba(52,170,220,0.1)",border:"1px solid rgba(52,170,220,0.3)",borderRadius:10,padding:"8px 14px",color:"#34aadc",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:loadingSamples?"wait":"pointer"}}>
                {loadingSamples?"Loading…":"↧ Load sample drawings"}
              </button>
            )}
          </div>
        )}

        {drawings.map(d=>{
          const fileUrl=DB.fileUrl("drawings",d.id,d.file);
          const isImage=/\.(jpg|jpeg|png|gif|webp|tif|tiff)$/i.test(d.file);
          const drawingPins=allPins.filter(p=>p.drawingId===d.id);
          const drawingNotes=getDrawingNotes(d.id);
          const drawingMarkup=getDrawingMarkup(d.id);
          const pinDefects=drawingPins.map(p=>defects.find(df=>df.id===p.entryId)).filter(Boolean);
          const sevCounts={};
          pinDefects.forEach(df=>{const s=df.severity||"Unknown";sevCounts[s]=(sevCounts[s]||0)+1;});
          return(
            <div key={d.id} onClick={()=>setViewing(d)} style={{background:"#fff",borderRadius:14,padding:0,marginBottom:12,cursor:"pointer",overflow:"hidden",border:"1px solid rgba(0,0,0,0.08)"}}>
              <div style={{position:"relative",background:"#f8f8f6"}}>
                {isImage&&<img src={fileUrl} alt={d.name} style={{width:"100%",maxHeight:"50vh",objectFit:"contain",display:"block",background:"#f8f8f6"}}/>}
                {!isImage&&<PdfThumb url={fileUrl}/>}
                {(drawingPins.length>0||drawingNotes.length>0||drawingMarkup.length>0)&&(
                  <div style={{position:"absolute",inset:0,pointerEvents:"none"}}>
                    {drawingMarkup.length>0&&(
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
                        {drawingMarkup.map((s,i)=>{
                          if(s.type==="freehand"&&s.points?.length>1){
                            const dPath="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
                            return <path key={i} d={dPath} stroke={s.color} strokeWidth="0.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
                          }
                          if(s.type==="arrow"&&s.start&&s.end){
                            const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
                            if(len<0.5)return null;
                            const angle=Math.atan2(dy,dx),hl=1.5;
                            return <g key={i}>
                              <line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.4"/>
                              <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle-0.45)} y2={s.end.y-hl*Math.sin(angle-0.45)} stroke={s.color} strokeWidth="0.4"/>
                              <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle+0.45)} y2={s.end.y-hl*Math.sin(angle+0.45)} stroke={s.color} strokeWidth="0.4"/>
                            </g>;
                          }
                          if(s.type==="circle"&&s.start&&s.end){
                            const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
                            const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
                            return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={s.color} strokeWidth="0.4" fill="none"/>;
                          }
                          if(s.type==="text"&&s.pos&&s.text){
                            const fs=s.fontSize||2.4;
                            const bw=Math.max(fs*3.3,s.text.length*fs*0.54);
                            const bh=fs*1.67;
                            const align=s.align||"left";
                            const valign=s.valign||"bottom";
                            let rectX=s.pos.x-0.2,textAnchor="start";
                            if(align==="center"){rectX=s.pos.x-bw/2;textAnchor="middle";}
                            else if(align==="right"){rectX=s.pos.x-bw+0.2;textAnchor="end";}
                            const textX=align==="center"?s.pos.x:(align==="right"?s.pos.x-0.4:s.pos.x+0.4);
                            let rectY;
                            if(valign==="top")rectY=s.pos.y;
                            else if(valign==="middle")rectY=s.pos.y-bh/2;
                            else rectY=s.pos.y-bh+0.4;
                            const textY=rectY+bh-0.6;
                            return <g key={i}>
                              <rect x={rectX} y={rectY} width={bw} height={bh} rx={fs*0.25} fill="rgba(0,0,0,0.65)"/>
                              <text x={textX} y={textY} fontSize={fs} fontWeight="700" fill={s.color} fontFamily="Barlow Condensed, sans-serif" textAnchor={textAnchor}>{s.text}</text>
                            </g>;
                          }
                          if(s.type==="photo"&&s.pos&&s.dataUrl){
                            return <g key={i}>
                              <image href={s.dataUrl} x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} preserveAspectRatio="xMidYMid meet"/>
                              <rect x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="0.25"/>
                            </g>;
                          }
                          return null;
                        })}
                      </svg>
                    )}
                    {drawingPins.map(p=>{
                      const pd=defects.find(df=>df.id===p.entryId);
                      const color=pd?SEV_COLOR[pd.severity]||"#ff6b00":"#8e8e93";
                      const isCritical=pd?.severity==="Critical"&&pd?.status==="Open";
                      return(
                        <div key={p.id} style={{position:"absolute",left:`${p.x}%`,top:`${p.y}%`,transform:"translate(-50%,-50%)"}}>
                          <div style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${color}`,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 1px 4px rgba(0,0,0,0.35)${isCritical?`,0 0 8px ${color}`:""}`}}>
                            <div style={{width:7,height:7,borderRadius:"50%",background:color}}/>
                          </div>
                        </div>
                      );
                    })}
                    {drawingNotes.map(n=>(
                      <div key={n.id} style={{position:"absolute",left:`${n.x}%`,top:`${n.y}%`,transform:"translate(-50%,-50%)",maxWidth:"40%"}}>
                        <div style={{background:"rgba(88,86,214,0.92)",border:"1px solid rgba(255,255,255,0.4)",borderRadius:6,padding:"1px 5px",boxShadow:"0 1px 4px rgba(0,0,0,0.35)",display:"flex",alignItems:"center",gap:3}}>
                          <span style={{fontSize:8}}>📝</span>
                          <span style={{fontSize:8,color:"#fff",fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:110}}>{n.text}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,color:"#1a1a1a"}}>{d.name}</div>
                    <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>By {d.uploadedBy||"—"} · {d.uploadedAt?new Date(d.uploadedAt).toLocaleDateString():""}</div>
                  </div>
                  {member?.role==="Admin"&&<button onClick={e=>{e.stopPropagation();deleteDrawing(d.id);}} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:"#ff3b30",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.delete")}</button>}
                </div>
                {(drawingPins.length>0||drawingNotes.length>0||drawingMarkup.length>0)&&(
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:8,flexWrap:"wrap"}}>
                    {drawingPins.length>0&&<span style={{fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif"}}>📌 {drawingPins.length} PIN{drawingPins.length>1?"S":""}</span>}
                    {drawingNotes.length>0&&<span style={{fontSize:11,fontWeight:700,color:"#5856d6",background:"rgba(88,86,214,0.12)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:10,padding:"2px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>📝 {drawingNotes.length} NOTE{drawingNotes.length>1?"S":""}</span>}
                    {drawingMarkup.length>0&&<span style={{fontSize:11,fontWeight:700,color:"#ff6b00",background:"rgba(255,107,0,0.12)",border:"1px solid rgba(255,107,0,0.25)",borderRadius:10,padding:"2px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>✏ {drawingMarkup.length} MARKUP{drawingMarkup.length>1?"S":""}</span>}
                    {Object.entries(sevCounts).map(([sev,count])=>(
                      <span key={sev} style={{fontSize:10,fontWeight:700,color:SEV_COLOR[sev]||"#8e8e93",background:(SEV_COLOR[sev]||"#8e8e93")+"18",border:`1px solid ${(SEV_COLOR[sev]||"#8e8e93")}30`,borderRadius:10,padding:"2px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>{count} {sev}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </>)}
      </div>

      {/* Batch Compare Modal */}
      {showBatchCompare&&(
        <div style={{position:"fixed",inset:0,zIndex:260,background:"#f0ede8",overflowY:"auto",animation:"slideUp 0.25s ease"}}>
          <SettingsBack onClose={()=>{setShowBatchCompare(false);setBatchSetAFiles([]);setBatchSetBFiles([]);setBatchMatches([]);setBatchResults([]);setBatchUnmatchedA([]);setBatchUnmatchedB([]);setBatchLabelA("SET A");setBatchLabelB("SET B");}} title={t("compare.batch_title")}/>
          <div style={{padding:20}}>
            {/* Hidden folder inputs */}
            <input ref={batchSetARef} type="file" accept=".pdf" multiple onChange={e=>handleBatchFolder(e,setBatchSetAFiles)} style={{display:"none"}}/>
            <input ref={batchSetBRef} type="file" accept=".pdf" multiple onChange={e=>handleBatchFolder(e,setBatchSetBFiles)} style={{display:"none"}}/>

            {/* Instructions */}
            <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
              {[["1","Select your first set of PDFs (baseline / original drawings)"],["2","Select your second set of PDFs (revised / updated drawings)"],["3","System auto-matches by filename similarity, then compares content"],["4","Review: check drawing count, matched pairs, and content differences"]].map(([n,t])=>(
                <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:"#5856d6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
                  <div style={{fontSize:13,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
                </div>
              ))}
              <div style={{fontSize:11,color:"rgba(0,0,0,0.35)",marginTop:8,borderTop:"1px solid rgba(0,0,0,0.06)",paddingTop:8}}>Use cases: Tender vs As-Built, M&E quantities, furniture layouts, landscape/tree species, structural revisions, and more.</div>
            </div>

            {/* Set label editors + folder selectors */}
            <div style={{display:"flex",gap:10,marginBottom:16}}>
              <div style={{flex:1}}>
                <input value={batchLabelA} onChange={e=>setBatchLabelA(e.target.value.toUpperCase())} maxLength={20} style={{width:"100%",border:"none",background:"transparent",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#5856d6",textAlign:"center",marginBottom:6,padding:4,borderBottom:"2px solid rgba(88,86,214,0.2)",boxSizing:"border-box",outline:"none"}}/>
                <button onClick={()=>batchSetARef.current?.click()} style={{width:"100%",background:batchSetAFiles.length?"rgba(88,86,214,0.08)":"#fff",border:`2px dashed ${batchSetAFiles.length?"#5856d6":"rgba(0,0,0,0.15)"}`,borderRadius:14,padding:20,cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:24,marginBottom:4}}>📂</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:batchSetAFiles.length?"#5856d6":"#1a1a1a"}}>{batchLabelA}</div>
                  <div style={{fontSize:12,color:batchSetAFiles.length?"#5856d6":"rgba(0,0,0,0.4)",marginTop:4}}>{batchSetAFiles.length?`${batchSetAFiles.length} PDF(s) selected`:"Select PDF files..."}</div>
                </button>
              </div>
              <div style={{flex:1}}>
                <input value={batchLabelB} onChange={e=>setBatchLabelB(e.target.value.toUpperCase())} maxLength={20} style={{width:"100%",border:"none",background:"transparent",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#ff6b00",textAlign:"center",marginBottom:6,padding:4,borderBottom:"2px solid rgba(255,107,0,0.2)",boxSizing:"border-box",outline:"none"}}/>
                <button onClick={()=>batchSetBRef.current?.click()} style={{width:"100%",background:batchSetBFiles.length?"rgba(255,107,0,0.08)":"#fff",border:`2px dashed ${batchSetBFiles.length?"#ff6b00":"rgba(0,0,0,0.15)"}`,borderRadius:14,padding:20,cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:24,marginBottom:4}}>📂</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:batchSetBFiles.length?"#ff6b00":"#1a1a1a"}}>{batchLabelB}</div>
                  <div style={{fontSize:12,color:batchSetBFiles.length?"#ff6b00":"rgba(0,0,0,0.4)",marginTop:4}}>{batchSetBFiles.length?`${batchSetBFiles.length} PDF(s) selected`:"Select PDF files..."}</div>
                </button>
              </div>
            </div>

            {/* Count summary */}
            {(batchSetAFiles.length>0||batchSetBFiles.length>0)&&(
              <div style={{display:"flex",gap:8,marginBottom:16}}>
                <div style={{flex:1,background:"rgba(88,86,214,0.08)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:12,textAlign:"center"}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#5856d6"}}>{batchSetAFiles.length}</div>
                  <div style={{fontSize:10,fontWeight:700,color:"rgba(88,86,214,0.6)",fontFamily:"'Barlow Condensed',sans-serif"}}>{batchLabelA}</div>
                </div>
                <div style={{flex:1,background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10,padding:12,textAlign:"center"}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff6b00"}}>{batchSetBFiles.length}</div>
                  <div style={{fontSize:10,fontWeight:700,color:"rgba(255,107,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif"}}>{batchLabelB}</div>
                </div>
                <div style={{flex:1,background:batchMatches.length?"rgba(48,209,88,0.08)":"rgba(255,59,48,0.08)",border:`1px solid ${batchMatches.length?"rgba(48,209,88,0.2)":"rgba(255,59,48,0.2)"}`,borderRadius:10,padding:12,textAlign:"center"}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:batchMatches.length?"#34c759":"#ff3b30"}}>{batchMatches.length}</div>
                  <div style={{fontSize:10,fontWeight:700,color:batchMatches.length?"rgba(48,209,88,0.6)":"rgba(255,59,48,0.6)",fontFamily:"'Barlow Condensed',sans-serif"}}>MATCHED</div>
                </div>
                {(batchUnmatchedA.length>0||batchUnmatchedB.length>0)&&(
                  <div style={{flex:1,background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:10,padding:12,textAlign:"center"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff3b30"}}>{batchUnmatchedA.length+batchUnmatchedB.length}</div>
                    <div style={{fontSize:10,fontWeight:700,color:"rgba(255,59,48,0.6)",fontFamily:"'Barlow Condensed',sans-serif"}}>UNMATCHED</div>
                  </div>
                )}
              </div>
            )}

            {/* ═══ PHASE 1: COMPLETENESS CHECK ═══ */}
            {(batchSetAFiles.length>0||batchSetBFiles.length>0)&&(
              <div style={{background:"#1a1a1a",borderRadius:14,padding:16,marginBottom:14}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#fff",letterSpacing:"0.1em",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{background:"#5856d6",color:"#fff",borderRadius:"50%",width:20,height:20,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:11,flexShrink:0}}>1</span>
                  COMPLETENESS CHECK
                  {batchMatches.length>0&&batchUnmatchedA.length===0&&batchUnmatchedB.length===0&&batchSetAFiles.length===batchSetBFiles.length&&<span style={{marginLeft:"auto",fontSize:11,color:"#34c759",fontWeight:700}}>COMPLETE</span>}
                  {(batchUnmatchedA.length>0||batchUnmatchedB.length>0||batchSetAFiles.length!==batchSetBFiles.length)&&<span style={{marginLeft:"auto",fontSize:11,color:"#ff9500",fontWeight:700}}>GAPS FOUND</span>}
                </div>
                <div style={{display:"flex",gap:6,marginBottom:10}}>
                  <div style={{flex:1,background:"rgba(88,86,214,0.15)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#fff"}}>{batchSetAFiles.length}</div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>{batchLabelA}</div>
                  </div>
                  <div style={{flex:1,background:"rgba(255,107,0,0.15)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#fff"}}>{batchSetBFiles.length}</div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>{batchLabelB}</div>
                  </div>
                  <div style={{flex:1,background:batchMatches.length?"rgba(48,209,88,0.15)":"rgba(255,255,255,0.05)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:batchMatches.length?"#34c759":"rgba(255,255,255,0.3)"}}>{batchMatches.length}</div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>PAIRED</div>
                  </div>
                  {(batchUnmatchedA.length+batchUnmatchedB.length>0)&&(
                    <div style={{flex:1,background:"rgba(255,59,48,0.15)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#ff3b30"}}>{batchUnmatchedA.length+batchUnmatchedB.length}</div>
                      <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>UNPAIRED</div>
                    </div>
                  )}
                </div>
                {batchSetAFiles.length!==batchSetBFiles.length&&batchSetAFiles.length>0&&batchSetBFiles.length>0&&(
                  <div style={{background:"rgba(255,149,0,0.12)",borderRadius:8,padding:"8px 12px",fontSize:11,color:"#ffcc00",marginBottom:8}}>
                    Count mismatch: {batchLabelA} has {batchSetAFiles.length} file(s), {batchLabelB} has {batchSetBFiles.length} file(s) — difference of {Math.abs(batchSetAFiles.length-batchSetBFiles.length)}
                  </div>
                )}
                {/* Unmatched files inline */}
                {batchUnmatchedA.length>0&&(
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:11,fontWeight:800,color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:4}}>ONLY IN {batchLabelA} ({batchUnmatchedA.length})</div>
                    {batchUnmatchedA.map((f,i)=><div key={i} style={{fontSize:11,padding:"3px 8px",marginBottom:2,background:"rgba(255,59,48,0.1)",borderRadius:4,borderLeft:"2px solid #ff3b30",color:"rgba(255,255,255,0.7)"}}>{f.name}</div>)}
                  </div>
                )}
                {batchUnmatchedB.length>0&&(
                  <div>
                    <div style={{fontSize:11,fontWeight:800,color:"#ff9500",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:4}}>ONLY IN {batchLabelB} ({batchUnmatchedB.length})</div>
                    {batchUnmatchedB.map((f,i)=><div key={i} style={{fontSize:11,padding:"3px 8px",marginBottom:2,background:"rgba(255,149,0,0.1)",borderRadius:4,borderLeft:"2px solid #ff9500",color:"rgba(255,255,255,0.7)"}}>{f.name}</div>)}
                  </div>
                )}
                {batchMatches.length>0&&batchUnmatchedA.length===0&&batchUnmatchedB.length===0&&batchSetAFiles.length===batchSetBFiles.length&&(
                  <div style={{fontSize:11,color:"#34c759",textAlign:"center",padding:4}}>All {batchSetAFiles.length} drawing(s) from both sets are paired.</div>
                )}
              </div>
            )}

            {/* Paired files list */}
            {batchMatches.length>0&&(
              <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
                <div style={lbl()}>PAIRED DRAWINGS ({batchMatches.length})</div>
                {batchMatches.map((m,i)=>(
                  <div key={i} style={{padding:"6px 10px",marginBottom:4,borderRadius:8,border:"1px solid rgba(0,0,0,0.06)",background:"#fafafa",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"#5856d6",width:20,textAlign:"center",flexShrink:0}}>{i+1}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}><span style={{color:"#5856d6",fontWeight:600}}>{m.fileA.name}</span></div>
                      <div style={{fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}><span style={{color:"#ff6b00",fontWeight:600}}>{m.fileB.name}</span></div>
                    </div>
                    <div style={{fontSize:10,color:"rgba(0,0,0,0.3)",flexShrink:0}}>{Math.round(m.similarity*100)}%</div>
                  </div>
                ))}
              </div>
            )}

            {/* ═══ PHASE 2: CONTENT COMPARISON ═══ */}
            {batchMatches.length>0&&(
              <div style={{background:"#1a1a1a",borderRadius:14,padding:16,marginBottom:14}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#fff",letterSpacing:"0.1em",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{background:"#ff6b00",color:"#fff",borderRadius:"50%",width:20,height:20,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:11,flexShrink:0}}>2</span>
                  {t("compare.content")} {t("compare.title")}
                  {batchResults.length>0&&!batchRunning&&<span style={{marginLeft:"auto",fontSize:11,color:"rgba(255,255,255,0.5)",fontWeight:400}}>{batchResults.length}/{batchMatches.length} compared</span>}
                </div>
                <button onClick={runBatchCompare} disabled={batchRunning} style={{width:"100%",background:batchRunning?"rgba(255,255,255,0.05)":"#ff6b00",border:"none",borderRadius:10,padding:14,color:batchRunning?"rgba(255,255,255,0.4)":"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:batchResults.length?12:0}}>
                  {batchRunning?<><Spin size={14}/> COMPARING {batchProgress.current} OF {batchProgress.total}...</>:`COMPARE ALL ${batchMatches.length} PAIRED DRAWINGS`}
                </button>

                {/* Per-file results */}
                {batchResults.length>0&&(
                  <div>
                    {/* Summary counters */}
                    <div style={{display:"flex",gap:6,marginBottom:10}}>
                      <div style={{flex:1,background:"rgba(48,209,88,0.12)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#34c759"}}>{batchResults.filter(r=>r.status==="identical").length}</div>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>IDENTICAL</div>
                      </div>
                      <div style={{flex:1,background:"rgba(255,149,0,0.12)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#ff9500"}}>{batchResults.filter(r=>r.status==="changed").length}</div>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>CHANGED</div>
                      </div>
                      <div style={{flex:1,background:"rgba(255,59,48,0.12)",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#ff3b30"}}>{batchResults.filter(r=>r.status==="error").length}</div>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:700}}>ERRORS</div>
                      </div>
                    </div>

                    {/* Each file result — expandable */}
                    {batchResults.map((r,i)=>(
                      <div key={i} style={{marginBottom:4}}>
                        <button onClick={()=>setBatchExpandedIdx(batchExpandedIdx===i?null:i)} style={{width:"100%",display:"flex",gap:8,alignItems:"center",padding:"8px 10px",borderRadius:r.status==="identical"?8:`8px 8px ${batchExpandedIdx===i?"0 0":"8px 8px"}`,border:"none",background:r.status==="identical"?"rgba(48,209,88,0.08)":r.status==="error"?"rgba(255,59,48,0.08)":"rgba(255,149,0,0.08)",cursor:"pointer",textAlign:"left"}}>
                          <div style={{fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:r.status==="identical"?"#34c759":r.status==="error"?"#ff3b30":"#ff9500",width:20,textAlign:"center",flexShrink:0}}>{i+1}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:11,color:"rgba(255,255,255,0.8)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.nameA}</div>
                          </div>
                          <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:6}}>
                            {r.status==="changed"&&<span style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>+{r.added} / -{r.removed}</span>}
                            <span style={{fontSize:10,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",color:r.status==="identical"?"#34c759":r.status==="error"?"#ff3b30":"#ff9500"}}>{r.status==="identical"?"SAME":r.status==="error"?"ERR":"DIFF"}</span>
                            {r.status==="changed"&&<span style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>{batchExpandedIdx===i?"▲":"▼"}</span>}
                          </div>
                        </button>
                        {/* Expanded detail — added/removed lines */}
                        {batchExpandedIdx===i&&r.status==="changed"&&(
                          <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderTop:"none",borderRadius:"0 0 8px 8px",padding:10}}>
                            <div style={{display:"flex",gap:6,marginBottom:8,fontSize:10,color:"rgba(255,255,255,0.4)"}}>
                              <span>Pages: {r.pagesA||"?"} vs {r.pagesB||"?"}</span>
                              <span>·</span>
                              <span>Text lines: {r.linesA||0} vs {r.linesB||0}</span>
                            </div>
                            {r.addedLines.length>0&&(
                              <div style={{marginBottom:6}}>
                                <div style={{fontSize:10,fontWeight:800,color:"#ff00ff",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:3}}>+ IN {batchLabelB} ONLY ({r.added})</div>
                                {r.addedLines.slice(0,10).map((l,j)=><div key={j} style={{fontSize:10,color:"rgba(255,255,255,0.6)",padding:"2px 6px",marginBottom:1,background:"rgba(255,0,255,0.06)",borderRadius:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l.text||l}</div>)}
                                {r.added>10&&<div style={{fontSize:10,color:"rgba(255,255,255,0.3)",paddingLeft:6}}>... and {r.added-10} more</div>}
                              </div>
                            )}
                            {r.removedLines.length>0&&(
                              <div>
                                <div style={{fontSize:10,fontWeight:800,color:"#ddcc00",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:3}}>- IN {batchLabelA} ONLY ({r.removed})</div>
                                {r.removedLines.slice(0,10).map((l,j)=><div key={j} style={{fontSize:10,color:"rgba(255,255,255,0.6)",padding:"2px 6px",marginBottom:1,background:"rgba(221,204,0,0.06)",borderRadius:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l.text||l}</div>)}
                                {r.removed>10&&<div style={{fontSize:10,color:"rgba(255,255,255,0.3)",paddingLeft:6}}>... and {r.removed-10} more</div>}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Export buttons */}
                    {!batchRunning&&(
                      <div style={{display:"flex",gap:8,marginTop:10}}>
                        <button onClick={exportBatchCsv} style={{flex:1,background:"rgba(52,170,220,0.2)",border:"1px solid rgba(52,170,220,0.4)",borderRadius:10,padding:"9px 10px",color:"#7fd7ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT CSV</button>
                        <button onClick={exportBatchPdf} style={{flex:1,background:"rgba(255,107,0,0.2)",border:"1px solid rgba(255,107,0,0.4)",borderRadius:10,padding:"9px 10px",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT PDF</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showCompare&&(
        <div style={{position:"fixed",inset:0,zIndex:260,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div style={{width:"100%",height:"100vh",background:"#1a1a1a",overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"14px 16px",borderBottom:"1px solid rgba(255,255,255,0.08)",display:"flex",alignItems:"center",gap:10}}>
              <button onClick={()=>{setShowCompare(false);setViewingSaved(null);}} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>{t("actions.back")}</button>
              <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>PDF {t("compare.title")}{viewingSaved?` (SAVED)`:""}</div>
              <button onClick={saveComparison} style={{background:"rgba(52,199,89,0.25)",border:"1px solid rgba(52,199,89,0.5)",borderRadius:18,padding:"7px 14px",color:"#9ef0b5",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",flexShrink:0}}>{t("actions.save")}</button>
            </div>

            <div style={{padding:16,overflowY:"auto",flex:1,minHeight:0,display:"flex",flexDirection:"column"}}>
              {/* Version selectors — compact row */}
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>BASE</div>
                  <select value={compareBaseId} onChange={e=>setCompareBaseId(e.target.value)} style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif"}}>
                    <option value="">Select PDF</option>
                    {pdfDrawings.map(d=><option key={d.id} value={d.id} style={{color:"#111"}}>{d.name}</option>)}
                  </select>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>REVISION</div>
                  <select value={compareTargetId} onChange={e=>setCompareTargetId(e.target.value)} style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif"}}>
                    <option value="">Select PDF</option>
                    {pdfDrawings.map(d=><option key={d.id} value={d.id} style={{color:"#111"}}>{d.name}</option>)}
                  </select>
                </div>
              </div>

              <button onClick={runCompare} disabled={comparing||!compareBaseId||!compareTargetId||compareBaseId===compareTargetId} style={{width:"100%",background:(!compareBaseId||!compareTargetId||compareBaseId===compareTargetId)?"rgba(255,255,255,0.1)":"#ff6b00",border:"none",borderRadius:10,padding:12,color:(!compareBaseId||!compareTargetId||compareBaseId===compareTargetId)?"rgba(255,255,255,0.35)":"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",marginBottom:10}}>
                {comparing?t("compare.comparing"):t("actions.run_comparison")}
              </button>

              {compareError&&<div style={{background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:"10px 12px",color:"#ff7f7f",fontSize:12,marginBottom:10}}>{compareError}</div>}

              {/* === VISUAL OVERLAY — main output, shown immediately after comparison === */}
              {(compareBaseId&&compareTargetId)&&(
                <div style={{marginBottom:10}}>
                  {/* Hidden source canvases for pixel data */}
                  <div style={{display:"none"}}>
                    <canvas ref={compareBaseCanvasRef}/>
                    <canvas ref={compareTargetCanvasRef}/>
                  </div>

                  {/* Overlay diff view — with zoom/pan support */}
                  <div style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1px solid rgba(255,255,255,0.18)",background:"#fff",marginBottom:8,flex:"1 1 auto",minHeight:"min(55vh, 400px)"}}>
                    {/* Zoom controls */}
                    <div style={{position:"absolute",right:8,top:8,zIndex:5,display:"flex",flexDirection:"column",gap:4}}>
                      <button onClick={()=>setCompareZoom(z=>Math.min(5,z+0.5))} style={{width:28,height:28,borderRadius:6,background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                      <button onClick={()=>{setCompareZoom(1);setComparePan({x:0,y:0});}} style={{width:28,height:28,borderRadius:6,background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",fontSize:9,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif"}}>{Math.round(compareZoom*100)}%</button>
                      <button onClick={()=>{setCompareZoom(z=>{const nz=Math.max(1,z-0.5);if(nz<=1)setComparePan({x:0,y:0});return nz;});}} style={{width:28,height:28,borderRadius:6,background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                      <div style={{background:"rgba(0,0,0,0.55)",borderRadius:6,padding:"3px 4px",fontSize:8,color:"rgba(255,255,255,0.6)",textAlign:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,lineHeight:1.3}}>{("ontouchstart"in window)?"Pinch\nzoom":<>Ctrl<br/>+scroll</>}</div>
                    </div>
                    {/* Legend */}
                    <div style={{position:"absolute",left:6,top:6,zIndex:5,display:"flex",gap:4,flexWrap:"wrap",pointerEvents:"none"}}>
                      {[{c:"#ff00ff",l:"ADDED (MAGENTA)",tc:"#ff8aff"},{c:"#ddcc00",l:"REMOVED (YELLOW)",tc:"#ffe066"},{c:"#00cccc",l:"EXISTING (CYAN)",tc:"#8affff"}].map(({c,l,tc})=>(
                        <div key={l} style={{background:"rgba(0,0,0,0.75)",borderRadius:6,padding:"3px 8px",fontSize:9,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",display:"flex",alignItems:"center",gap:4}}>
                          <span style={{width:10,height:3,background:c,display:"inline-block"}}/><span style={{color:tc}}>{l}</span>
                        </div>
                      ))}
                    </div>
                    {/* Zoomable + pannable area */}
                    <div ref={compareBoardRef} style={{touchAction:compareMarkupTool||compareZoom>1?"none":"pan-y",overflow:"hidden"}}
                      onMouseDown={onCompareMarkupDown} onMouseMove={onCompareMarkupMove} onMouseUp={onCompareMarkupUp} onMouseLeave={onCompareMarkupUp}
                      onTouchStart={onCompareMarkupDown} onTouchMove={onCompareMarkupMove} onTouchEnd={onCompareMarkupUp}
                      onWheel={e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();setCompareZoom(z=>{const nz=Math.max(1,Math.min(5,z+(e.deltaY<0?0.3:-0.3)));if(nz<=1)setComparePan({x:0,y:0});return nz;});}}>
                      <div style={{transform:`scale(${compareZoom}) translate(${comparePan.x/compareZoom}px,${comparePan.y/compareZoom}px)`,transformOrigin:"center center"}}>
                        <canvas ref={compareOverlayCanvasRef} style={{width:"100%",display:"block",background:"#fff"}}/>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:compareMarkupTool==="select"?"auto":"none"}}>
                          {renderCompareMarkup(compareMarkupStrokes,compareMarkupTool==="select")}
                          {compareMarkupCurrent&&renderCompareMarkup([compareMarkupCurrent],false)}
                          {comparePendingPhoto&&comparePhotoPlaceRect&&comparePhotoPlaceRect.w>0&&(
                            <g>
                              <image href={comparePendingPhoto.dataUrl} x={comparePhotoPlaceRect.x} y={comparePhotoPlaceRect.y} width={comparePhotoPlaceRect.w} height={comparePhotoPlaceRect.w*comparePendingPhoto.aspect} preserveAspectRatio="xMidYMid meet" opacity="0.7"/>
                              <rect x={comparePhotoPlaceRect.x} y={comparePhotoPlaceRect.y} width={comparePhotoPlaceRect.w} height={comparePhotoPlaceRect.w*comparePendingPhoto.aspect} fill="none" stroke="#5856d6" strokeWidth="0.4" strokeDasharray="1 0.6"/>
                            </g>
                          )}
                          {cmpPolylinePoints.length>1&&<polyline points={cmpPolylinePoints.map(p=>`${p.x},${p.y}`).join(" ")} stroke={compareMarkupColor} strokeWidth="0.5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.8 0.4"/>}
                          {cmpPolylinePoints.length===1&&<circle cx={cmpPolylinePoints[0].x} cy={cmpPolylinePoints[0].y} r="0.5" fill={compareMarkupColor}/>}
                          {compareHighlight&&<>
                            <rect x={compareHighlight.x-1} y={compareHighlight.y-1.5} width={Math.max(compareHighlight.w+2,12)} height="3" rx="0.5" fill="none" stroke={compareHighlight.color} strokeWidth="0.4" strokeDasharray="1,0.5">
                              <animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/>
                            </rect>
                            <line x1={compareHighlight.x-2} y1={compareHighlight.y} x2={compareHighlight.x+compareHighlight.w+3} y2={compareHighlight.y} stroke={compareHighlight.color} strokeWidth="0.15" strokeDasharray="0.5,0.5"/>
                          </>}
                        </svg>
                      </div>
                    </div>
                    {comparePreviewLoading&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(255,255,255,0.7)",color:"#333",fontSize:12,zIndex:5}}><Spin size={14}/> <span style={{marginLeft:8}}>Generating overlay diff...</span></div>}
                  </div>
                </div>
              )}

              {/* AI + markup controls — pinned at bottom */}
              <div style={{flexShrink:0}}>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <button onClick={runCompareAi} disabled={compareAiBusy||!compareRes} style={{flex:1,background:(!compareRes||compareAiBusy)?"rgba(255,255,255,0.1)":"rgba(88,86,214,0.28)",border:"1px solid rgba(88,86,214,0.45)",borderRadius:10,padding:"9px 10px",color:(!compareRes||compareAiBusy)?"rgba(255,255,255,0.35)":"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>
                  {compareAiBusy?"AI ANALYZING...":"AI ANALYZE & SUMMARIZE"}
                </button>
                <button onClick={regenerateCompareAi} disabled={compareAiBusy||!compareRes||compareAiLocked} style={{flex:1,background:(!compareRes||compareAiBusy||compareAiLocked)?"rgba(255,255,255,0.1)":"rgba(52,170,220,0.22)",border:"1px solid rgba(52,170,220,0.4)",borderRadius:10,padding:"9px 10px",color:(!compareRes||compareAiBusy||compareAiLocked)?"rgba(255,255,255,0.35)":"#9adfff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>
                  REGENERATE
                </button>
              </div>
              {!aiReady&&<div style={{background:"rgba(255,149,0,0.12)",border:"1px solid rgba(255,149,0,0.35)",borderRadius:10,padding:"9px 10px",color:"#ffbf66",fontSize:11,marginBottom:10}}>AI not configured. Open AI Setup to enable AI-supported comparison reporting.</div>}
              {compareAiError&&<div style={{background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:"9px 10px",color:"#ff8f8f",fontSize:11,marginBottom:10}}>{compareAiError}</div>}
              {compareAiReport&&<div style={{background:"rgba(88,86,214,0.12)",border:"1px solid rgba(88,86,214,0.3)",borderRadius:10,padding:"10px",whiteSpace:"pre-wrap",fontSize:11,color:"#e6e2ff",lineHeight:1.45,marginBottom:10}}>{compareAiReport}</div>}
              {compareAiReport&&(
                <div style={{background:compareAiLocked?"rgba(52,199,89,0.14)":"rgba(255,255,255,0.06)",border:`1px solid ${compareAiLocked?"rgba(52,199,89,0.35)":"rgba(255,255,255,0.18)"}`,borderRadius:10,padding:"9px 10px",marginBottom:12}}>
                  <div style={{fontSize:11,color:compareAiLocked?"#9ef0b5":"rgba(255,255,255,0.7)",marginBottom:8,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>
                    {compareAiLocked?t("ai.report_locked"):t("ai.report_draft")}
                    {compareAiApprovedBy?` · ${compareAiApprovedBy}`:""}
                    {compareAiApprovedAt?` · ${new Date(compareAiApprovedAt).toLocaleString()}`:""}
                  </div>
                  {canApproveAi&&(
                    <div style={{display:"flex",gap:8}}>
                      {!compareAiLocked&&<button onClick={approveAndLockCompareAi} style={{flex:1,background:"rgba(52,199,89,0.2)",border:"1px solid rgba(52,199,89,0.4)",borderRadius:8,padding:"8px 10px",color:"#9ef0b5",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>APPROVE & LOCK</button>}
                      {compareAiLocked&&<button onClick={unlockCompareAi} style={{flex:1,background:"rgba(255,149,0,0.18)",border:"1px solid rgba(255,149,0,0.4)",borderRadius:8,padding:"8px 10px",color:"#ffd08a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>{t("actions.unlock")}</button>}
                    </div>
                  )}
                  {compareAuditLog.length>0&&(
                    <div style={{marginTop:8}}>
                      <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>AUDIT TRAIL</div>
                      <div style={{maxHeight:120,overflowY:"auto"}}>
                        {compareAuditLog.map((e,i)=>(
                          <div key={i} style={{fontSize:10,color:e.action==="lock"?"#9ef0b5":"#ffd08a",padding:"3px 0",borderBottom:i<compareAuditLog.length-1?"1px solid rgba(255,255,255,0.06)":"none",display:"flex",gap:6,alignItems:"baseline"}}>
                            <span style={{fontWeight:700,textTransform:"uppercase",minWidth:42}}>{e.action==="lock"?"LOCKED":"UNLOCKED"}</span>
                            <span style={{color:"rgba(255,255,255,0.6)"}}>{e.by}</span>
                            <span style={{color:"rgba(255,255,255,0.35)"}}>{new Date(e.at).toLocaleString()}</span>
                            {e.reason&&e.action==="unlock"&&<span style={{color:"rgba(255,255,255,0.5)",fontStyle:"italic"}}>— {e.reason}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Markup tools — below overlay */}
              {(compareBaseId&&compareTargetId)&&(
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                  <input ref={comparePhotoInputRef} type="file" accept="image/*" capture="environment" onChange={handleComparePhotoFile} style={{display:"none"}}/>
                  {[{id:"select",label:"✥",title:"Select / Move"},{id:"freehand",label:"✏",title:"Freehand"},{id:"highlight",label:null,title:"Highlight Marker"},{id:"line",label:null,title:"Line"},{id:"arrow",label:"↗",title:"Arrow"},{id:"polyline",label:null,title:"Polyline / Polygon"},{id:"circle",label:null,title:"Circle"},{id:"rect",label:null,title:"Rectangle"},{id:"cloud",label:null,title:"Revision Cloud"},{id:"dimension",label:null,title:"Dimension"},{id:"text",label:"T",title:"Text"},{id:"callout",label:null,title:"Callout / Leader Note"},{id:"stamp",label:"⊞",title:"Stamp"}].map(t=>(
                    <button key={t.id} onClick={()=>{setCompareMarkupTool(t.id);if(t.id!=="select")setCompareSelectedIdx(null);}} title={t.title} style={{width:34,height:34,borderRadius:8,border:compareMarkupTool===t.id?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:compareMarkupTool===t.id?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {t.id==="highlight"?<svg width="18" height="18" viewBox="0 0 20 20"><rect x="2" y="7" width="16" height="6" rx="1" fill="#fff" opacity="0.5"/><line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.4"/></svg>
                      :t.id==="polyline"?<svg width="18" height="18" viewBox="0 0 20 20"><polyline points="2,16 7,4 13,14 18,6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      :t.id==="circle"?<svg width="18" height="18" viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="8" ry="8" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
                      :t.id==="rect"?<svg width="18" height="18" viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="12" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
                      :t.id==="cloud"?<svg width="18" height="18" viewBox="0 0 20 20"><path d="M4,14 A3,3 0 0,1 4,8 A4,4 0 0,1 8,5 A4,4 0 0,1 14,5 A4,4 0 0,1 17,8 A3,3 0 0,1 17,14 Z" fill="none" stroke="#fff" strokeWidth="1.2"/></svg>
                      :t.id==="line"?<svg width="18" height="18" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      :t.id==="dimension"?<svg width="18" height="18" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="#fff" strokeWidth="1"/><line x1="3" y1="6" x2="3" y2="14" stroke="#fff" strokeWidth="1.5"/><line x1="17" y1="6" x2="17" y2="14" stroke="#fff" strokeWidth="1.5"/><text x="10" y="8" fill="#fff" fontSize="6" textAnchor="middle" fontFamily="sans-serif">d</text></svg>
                      :t.id==="callout"?<svg width="18" height="18" viewBox="0 0 20 20"><line x1="3" y1="16" x2="10" y2="6" stroke="#fff" strokeWidth="1.2"/><rect x="9" y="2" width="9" height="7" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.2"/><text x="13.5" y="7.5" fill="#fff" fontSize="5" textAnchor="middle" fontFamily="sans-serif">A</text></svg>
                      :t.label}
                    </button>
                  ))}
                  <button onClick={()=>comparePhotoInputRef.current?.click()} title={t("markup.add_photo")} style={{width:34,height:34,borderRadius:8,border:"2px solid rgba(255,107,0,0.35)",background:"rgba(255,107,0,0.1)",color:"#ffb48a",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>📷</button>
                  {comparePendingPhoto&&(
                    <div style={{display:"flex",alignItems:"center",gap:8,background:"rgba(88,86,214,0.15)",borderRadius:8,padding:"6px 12px"}}>
                      <span style={{fontSize:12,color:"#fff",fontWeight:600}}>{t("actions.tap_to_place")}</span>
                      <button onClick={cancelComparePendingPhoto} style={{background:"rgba(255,59,48,0.2)",border:"none",borderRadius:6,padding:"3px 8px",color:"#ff6b6b",fontSize:11,fontWeight:700,cursor:"pointer"}}>{t("actions.cancel")}</button>
                    </div>
                  )}
                  <div style={{width:1,height:20,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
                  {/* Color — consolidated swatch dropdown */}
                  {(()=>{
                    const COLORS=["#ff3b30","#ff9500","#ffcc00","#34c759","#fff"];
                    const sel=compareMarkupStrokes[compareSelectedIdx];
                    const activeColor=sel?.color||compareMarkupColor;
                    const applyColor=c=>{
                      setCompareMarkupColor(c);
                      if(compareSelectedIdx!=null){
                        setCompareMarkupStrokes(strokes=>strokes.map((s,i)=>i===compareSelectedIdx?{...s,color:c}:s));
                      }
                    };
                    return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(compareColorTimer.current);setShowCompareColorMenu(true);}} onMouseLeave={()=>{compareColorTimer.current=setTimeout(()=>setShowCompareColorMenu(false),250);}}>
                      <button onClick={()=>setShowCompareColorMenu(v=>!v)} title="Color" style={{width:30,height:28,borderRadius:6,border:"2px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>
                        <span style={{width:16,height:16,borderRadius:"50%",background:activeColor,border:"1.5px solid rgba(0,0,0,0.5)",boxShadow:"0 0 0 1px rgba(255,255,255,0.4) inset"}}/>
                      </button>
                      {showCompareColorMenu&&<div onMouseEnter={()=>clearTimeout(compareColorTimer.current)} onMouseLeave={()=>{compareColorTimer.current=setTimeout(()=>setShowCompareColorMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",display:"flex",gap:6}}>
                        {COLORS.map(c=>(
                          <button key={c} onClick={()=>{applyColor(c);setShowCompareColorMenu(false);}} style={{width:26,height:26,borderRadius:"50%",border:activeColor===c?"3px solid #fff":"2px solid rgba(255,255,255,0.2)",background:c,cursor:"pointer"}}/>
                        ))}
                      </div>}
                    </div>;
                  })()}
                  {/* Line style toggle */}
                  <button onClick={()=>setCompareMarkupLineStyle(s=>s==="solid"?"dotted":"solid")} title={compareMarkupLineStyle==="solid"?t("markup.solid"):t("markup.dotted")} style={{width:30,height:28,borderRadius:6,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <svg width="18" height="18" viewBox="0 0 20 20">
                      {compareMarkupLineStyle==="solid"
                        ?<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                        :<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3"/>}
                    </svg>
                  </button>
                  {/* Size — consolidated dropdown */}
                  {(()=>{
                    const SIZES=[{id:"S",v:1.8},{id:"M",v:2.4},{id:"L",v:3.4},{id:"XL",v:4.8}];
                    const sel=compareMarkupStrokes[compareSelectedIdx];
                    const activeSize=(sel&&sel.type==="text")?(sel.fontSize||2.4):compareTextSize;
                    const activeLabel=SIZES.find(s=>Math.abs(activeSize-s.v)<0.01)?.id||"M";
                    return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(compareSizeTimer.current);setShowCompareSizeMenu(true);}} onMouseLeave={()=>{compareSizeTimer.current=setTimeout(()=>setShowCompareSizeMenu(false),250);}}>
                      <button onClick={()=>setShowCompareSizeMenu(v=>!v)} title={`Text size ${activeLabel}`} style={{minWidth:30,height:28,padding:"0 6px",borderRadius:6,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>{activeLabel}</button>
                      {showCompareSizeMenu&&<div onMouseEnter={()=>clearTimeout(compareSizeTimer.current)} onMouseLeave={()=>{compareSizeTimer.current=setTimeout(()=>setShowCompareSizeMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",display:"flex",gap:4}}>
                        {SIZES.map(sz=>{
                          const isActive=activeLabel===sz.id;
                          return <button key={sz.id} onClick={()=>{setCompareTextSizeBoth(sz.v);setShowCompareSizeMenu(false);}} style={{minWidth:28,height:28,padding:"0 6px",borderRadius:6,border:isActive?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:isActive?"rgba(88,86,214,0.25)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>{sz.id}</button>;
                        })}
                      </div>}
                    </div>;
                  })()}
                  <div style={{width:1,height:20,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
                  {/* Text alignment (9-way) — consolidated dropdown */}
                  {(()=>{
                    const sel=compareMarkupStrokes[compareSelectedIdx];
                    const curH=(sel&&sel.type==="text")?(sel.align||"left"):compareTextAlign;
                    const curV=(sel&&sel.type==="text")?(sel.valign||"bottom"):compareTextValign;
                    const HS=["left","center","right"],VS=["top","middle","bottom"];
                    const hIdx=HS.indexOf(curH),vIdx=VS.indexOf(curV);
                    return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(alignMenuTimer.current);setShowAlignMenu(true);}} onMouseLeave={()=>{alignMenuTimer.current=setTimeout(()=>setShowAlignMenu(false),250);}}>
                      <button onClick={()=>setShowAlignMenu(v=>!v)} title={`Text align: ${curV}-${curH}`} style={{width:30,height:28,borderRadius:6,border:"2px solid rgba(88,86,214,0.35)",background:"rgba(88,86,214,0.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>
                        <svg width="14" height="14" viewBox="-0.1 -0.1 3.2 3.2">
                          {[0,1,2].map(r=>[0,1,2].map(c=>(
                            <rect key={`${r}-${c}`} x={c} y={r} width="0.9" height="0.9" fill={(r===vIdx&&c===hIdx)?"#5856d6":"rgba(255,255,255,0.25)"} stroke="rgba(0,0,0,0.4)" strokeWidth="0.05"/>
                          )))}
                        </svg>
                      </button>
                      {showAlignMenu&&<div onMouseEnter={()=>clearTimeout(alignMenuTimer.current)} onMouseLeave={()=>{alignMenuTimer.current=setTimeout(()=>setShowAlignMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)"}}>
                        <div style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6,whiteSpace:"nowrap"}}>TEXT ALIGNMENT</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,26px)",gap:3}}>
                          {VS.map(v=>HS.map(h=>{
                            const isActive=curH===h&&curV===v;
                            return <button key={`${v}-${h}`} onClick={()=>{setCompareTextAnchor(v,h);setShowAlignMenu(false);}} title={`${v}-${h}`} style={{width:26,height:26,borderRadius:4,border:isActive?"1.5px solid #5856d6":"1.5px solid rgba(255,255,255,0.15)",background:isActive?"rgba(88,86,214,0.25)":"rgba(255,255,255,0.05)",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                              <svg width="14" height="14" viewBox="-0.1 -0.1 3.2 3.2">
                                {[0,1,2].map(r=>[0,1,2].map(c=>(
                                  <rect key={`${r}-${c}`} x={c} y={r} width="0.9" height="0.9" fill={(VS[r]===v&&HS[c]===h)?"#5856d6":"rgba(255,255,255,0.2)"} stroke="rgba(0,0,0,0.4)" strokeWidth="0.05"/>
                                )))}
                              </svg>
                            </button>;
                          }))}
                        </div>
                      </div>}
                    </div>;
                  })()}
                  <div style={{flex:1}}/>
                  {(()=>{
                    const sel=compareMarkupStrokes[compareSelectedIdx];
                    if(sel?.type!=="photo")return null;
                    return <>
                      <button onClick={()=>scaleComparePhoto(0.85)} title="Shrink photo" style={{width:26,height:28,borderRadius:6,border:"1px solid rgba(255,107,0,0.35)",background:"rgba(255,107,0,0.1)",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>−</button>
                      <button onClick={()=>scaleComparePhoto(1.18)} title="Enlarge photo" style={{width:26,height:28,borderRadius:6,border:"1px solid rgba(255,107,0,0.35)",background:"rgba(255,107,0,0.1)",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>+</button>
                    </>;
                  })()}
                  {/* Stamp picker */}
                  {compareMarkupTool==="stamp"&&(
                    <div style={{position:"relative"}}>
                      <button onClick={()=>setShowCmpStampMenu(v=>!v)} style={{height:26,padding:"0 6px",borderRadius:6,border:"2px solid rgba(88,86,214,0.4)",background:"rgba(88,86,214,0.15)",color:"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{cmpStampType}</button>
                      {showCmpStampMenu&&<div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:6,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",maxHeight:200,overflowY:"auto",minWidth:140}}>
                        {CMP_STAMP_PRESETS.map(st=>(
                          <button key={st} onClick={()=>{setCmpStampType(st);setShowCmpStampMenu(false);}} style={{display:"block",width:"100%",padding:"5px 8px",border:"none",borderRadius:4,background:cmpStampType===st?"rgba(88,86,214,0.25)":"none",color:st==="APPROVED"?"#34c759":st==="REJECTED"?"#ff3b30":st==="REVIEWED"?"#007aff":"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:10,cursor:"pointer",textAlign:"left",marginBottom:2}}>{st}</button>
                        ))}
                      </div>}
                    </div>
                  )}
                  {/* Polyline controls */}
                  {compareMarkupTool==="polyline"&&cmpPolylinePoints.length>0&&(
                    <>
                      <button onClick={()=>setCmpPolylineClosed(v=>!v)} style={{height:26,padding:"0 6px",borderRadius:6,border:cmpPolylineClosed?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:cmpPolylineClosed?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{cmpPolylineClosed?"POLYGON":"OPEN"}</button>
                      <button onClick={finishCmpPolyline} style={{height:26,padding:"0 8px",borderRadius:6,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>DONE ({cmpPolylinePoints.length})</button>
                    </>
                  )}
                  {compareSelectedIdx!=null&&<button onClick={deleteCompareSelected} title="Delete selected" style={{background:"rgba(255,59,48,0.2)",border:"1px solid rgba(255,59,48,0.35)",borderRadius:8,padding:"6px 10px",color:"#ff8f8f",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>DEL</button>}
                  <button onClick={undoCompareMarkup} disabled={!compareMarkupStrokes.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:compareMarkupStrokes.length?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.undo")}</button>
                  <button onClick={redoCompareMarkup} disabled={!compareRedoStack.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:compareRedoStack.length?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.redo")}</button>
                  <button onClick={clearCompareMarkup} disabled={!compareMarkupStrokes.length} style={{background:"rgba(255,59,48,0.2)",border:"none",borderRadius:8,padding:"6px 10px",color:compareMarkupStrokes.length?"#ff8f8f":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>CLEAR</button>
                </div>
              )}
              </div>{/* end flexShrink:0 wrapper */}

              {compareRes&&(
                <div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:10}}>
                    {compareRes.baseName} → {compareRes.targetName} · {new Date(compareRes.generatedAt).toLocaleString()}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:12}}>
                    <button onClick={exportCompareCsv} style={{flex:1,background:"rgba(52,170,220,0.25)",border:"1px solid rgba(52,170,220,0.45)",borderRadius:10,padding:"9px 10px",color:"#7fd7ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT CSV</button>
                    <button onClick={exportComparePdf} style={{flex:1,background:"rgba(255,107,0,0.22)",border:"1px solid rgba(255,107,0,0.4)",borderRadius:10,padding:"9px 10px",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT PDF</button>
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <div style={{flex:1,background:"rgba(255,0,255,0.12)",border:"1px solid rgba(255,0,255,0.3)",borderRadius:10,padding:10}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:BCA_SCDF_REVISION_COLORS.added}}>ADDED LINES</div>
                      <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>{compareRes.totalAdded}</div>
                    </div>
                    <div style={{flex:1,background:"rgba(221,204,0,0.12)",border:"1px solid rgba(221,204,0,0.3)",borderRadius:10,padding:10}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:BCA_SCDF_REVISION_COLORS.removed}}>REMOVED LINES</div>
                      <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>{compareRes.totalRemoved}</div>
                    </div>
                  </div>
                  {aiReady&&(compareRes.totalAdded+compareRes.totalRemoved)>0&&(
                    <button onClick={aiRenameDiffItems} disabled={aiRenameBusy} style={{width:"100%",background:aiRenameBusy?"rgba(255,255,255,0.1)":"rgba(88,86,214,0.22)",border:"1px solid rgba(88,86,214,0.4)",borderRadius:10,padding:"9px 10px",color:aiRenameBusy?"rgba(255,255,255,0.35)":"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                      {aiRenameBusy?<><Spin size={12}/> AI IDENTIFYING OBJECTS...</>:"🤖 AI AUTO-RENAME ITEMS"}
                    </button>
                  )}

                  {["added","removed"].map(diffType=>{
                    const items=diffType==="added"?compareRes.added:compareRes.removed;
                    const accentColor=diffType==="added"?"#ff00ff":"#ddcc00";
                    const labelColor=diffType==="added"?BCA_SCDF_REVISION_COLORS.added:BCA_SCDF_REVISION_COLORS.removed;
                    const label=diffType==="added"?"ADDED (MAGENTA)":"REMOVED (YELLOW)";
                    return(
                      <div key={diffType} style={{marginBottom:12}}>
                        <div style={{fontSize:11,fontWeight:700,color:labelColor,marginBottom:6,fontFamily:"'Barlow Condensed',sans-serif"}}>{label}</div>
                        <div style={{maxHeight:220,overflowY:"auto",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:10}}>
                          {items.length===0&&<div style={{fontSize:12,color:"rgba(255,255,255,0.45)"}}>No {diffType} lines detected.</div>}
                          {items.map((line,i)=>{
                            const l=typeof line==="object"?line:{text:line};
                            const key=`${diffType}_${i}`;
                            const edit=diffEdits[key];
                            const displayName=edit?.name||l.text||line;
                            const remark=edit?.remark||"";
                            const active=compareHighlight?.text===l.text;
                            const selColor="#3b82f6";
                            return(
                              <div key={i} style={{padding:"5px 6px",margin:"0 -6px",borderRadius:active?8:0,background:active?"rgba(59,130,246,0.2)":"none",border:active?"1px solid rgba(59,130,246,0.5)":"1px solid transparent",borderBottom:i===items.length-1&&!active?"none":active?"1px solid rgba(59,130,246,0.5)":"1px solid rgba(255,255,255,0.06)"}}>
                                <div style={{display:"flex",alignItems:"center",gap:6}}>
                                  <div style={{flex:1,fontSize:11,color:active?selColor:"rgba(255,255,255,0.86)",fontWeight:active?700:400,wordBreak:"break-word",cursor:l.xPct!==undefined?"pointer":"default"}}
                                    onClick={()=>{if(l.xPct!==undefined){setCompareHighlight({x:l.xPct,y:l.yPct,w:l.wPct||10,text:l.text,color:selColor});setCompareZoom(2);setComparePan({x:-(l.xPct-50)*2.5,y:-(l.yPct-50)*2.5});}}}
                                  >{edit?.name?<><span style={{textDecoration:"line-through",opacity:0.4,fontSize:10}}>{l.text||line}</span> <span style={{color:active?selColor:accentColor}}>{edit.name}</span></>:displayName}</div>
                                  <button onClick={()=>setEditingDiffItem({key,type:diffType,original:l.text||line,name:edit?.name||"",remark:edit?.remark||""})} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:6,padding:"3px 7px",color:"rgba(255,255,255,0.5)",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",flexShrink:0}}>✎</button>
                                </div>
                                {remark&&<div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:3,paddingLeft:2,fontStyle:"italic",borderLeft:`2px solid ${accentColor}40`}}>💬 {remark}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {compareTextPoint&&(
                <div style={{position:"fixed",inset:0,zIndex:280,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                  <div style={{width:"100%",maxWidth:340,background:"#1a1a1a",borderRadius:14,padding:16,border:"1px solid rgba(255,255,255,0.15)"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:10}}>ADD TEXT ANNOTATION</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <input autoFocus value={compareTextValue} onChange={e=>setCompareTextValue(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCompareText()} placeholder="Type or dictate annotation..." style={{flex:1,padding:11,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:13,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
                      <MicBtn onResult={t=>setCompareTextValue(v=>v?(v+" "+t):t)} append currentValue={compareTextValue}/>
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>{setCompareTextPoint(null);setCompareTextValue("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
                      <button onClick={addCompareText} disabled={!compareTextValue.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:compareTextValue.trim()?"#5856d6":"rgba(255,255,255,0.1)",color:compareTextValue.trim()?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
                    </div>
                  </div>
                </div>
              )}

              {comparePendingDim&&(
                <div style={{position:"fixed",inset:0,zIndex:280,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                  <div style={{width:"100%",maxWidth:340,background:"#1a1a1a",borderRadius:14,padding:16,border:"1px solid rgba(255,255,255,0.15)"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:6}}>DIMENSION LABEL</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Enter the measurement (e.g. 3.5m, 1200mm). Leave blank for no label.</div>
                    <input autoFocus value={compareDimLabel} onChange={e=>setCompareDimLabel(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){addCompareStroke({...comparePendingDim,label:compareDimLabel.trim()});setComparePendingDim(null);setCompareDimLabel("");}}} placeholder="e.g. 3500mm" style={{width:"100%",padding:11,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>{setComparePendingDim(null);setCompareDimLabel("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
                      <button onClick={()=>{addCompareStroke({...comparePendingDim,label:compareDimLabel.trim()});setComparePendingDim(null);setCompareDimLabel("");}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Callout text modal */}
              {cmpCalloutStroke&&(
                <div style={{position:"fixed",inset:0,zIndex:280,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                  <div style={{width:"100%",maxWidth:340,background:"#1a1a1a",borderRadius:14,padding:16,border:"1px solid rgba(255,255,255,0.15)"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:6}}>CALLOUT LABEL</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Enter callout text. Leave blank for arrow only.</div>
                    <input autoFocus value={cmpCalloutText} onChange={e=>setCmpCalloutText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){addCompareStroke({...cmpCalloutStroke,text:cmpCalloutText.trim(),fontSize:compareTextSize});setCmpCalloutStroke(null);setCmpCalloutText("");}}} placeholder="e.g. Check alignment" style={{width:"100%",padding:11,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>{addCompareStroke({...cmpCalloutStroke,text:""});setCmpCalloutStroke(null);setCmpCalloutText("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>SKIP</button>
                      <button onClick={()=>{addCompareStroke({...cmpCalloutStroke,text:cmpCalloutText.trim(),fontSize:compareTextSize});setCmpCalloutStroke(null);setCmpCalloutText("");}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
                    </div>
                  </div>
                </div>
              )}

              {showUnlockPrompt&&(
                <div style={{position:"fixed",inset:0,zIndex:280,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                  <div style={{width:"100%",maxWidth:380,background:"#1a1a1a",borderRadius:14,padding:16,border:"1px solid rgba(255,149,0,0.35)"}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#ffd08a",marginBottom:4}}>UNLOCK AI REPORT</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.55)",marginBottom:12}}>Provide a reason for unlocking this approved report. This will be recorded in the audit trail.</div>
                    <textarea autoFocus value={unlockReason} onChange={e=>setUnlockReason(e.target.value)} placeholder="e.g. Client requested revision after site walkthrough..." rows={3} style={{width:"100%",padding:11,borderRadius:10,border:"1px solid rgba(255,149,0,0.3)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:13,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box",resize:"vertical"}}/>
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>{setShowUnlockPrompt(false);setUnlockReason("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
                      <button onClick={()=>confirmUnlock(unlockReason.trim())} disabled={!unlockReason.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:unlockReason.trim()?"rgba(255,149,0,0.35)":"rgba(255,255,255,0.1)",color:unlockReason.trim()?"#ffd08a":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>CONFIRM UNLOCK</button>
                    </div>
                  </div>
                </div>
              )}

              {editingDiffItem&&(
                <div style={{position:"fixed",inset:0,zIndex:280,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                  <div style={{width:"100%",maxWidth:400,background:"#1a1a1a",borderRadius:14,padding:16,border:`1px solid ${editingDiffItem.type==="added"?"rgba(255,59,48,0.35)":"rgba(0,85,255,0.35)"}`}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:editingDiffItem.type==="added"?"#ff8a8a":"#8ab4ff",marginBottom:4}}>EDIT {editingDiffItem.type.toUpperCase()} ITEM</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginBottom:12,wordBreak:"break-word"}}>Original: {editingDiffItem.original}</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.45)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>RENAME</div>
                    <input value={editingDiffItem.name} onChange={e=>setEditingDiffItem(prev=>({...prev,name:e.target.value}))} placeholder={t("fields.custom_name_placeholder")} style={{width:"100%",padding:10,borderRadius:8,border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box",marginBottom:10}}/>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.45)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>REMARKS / NOTES</div>
                    <textarea value={editingDiffItem.remark} onChange={e=>setEditingDiffItem(prev=>({...prev,remark:e.target.value}))} placeholder={t("fields.followup_placeholder")} rows={3} style={{width:"100%",padding:10,borderRadius:8,border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box",resize:"vertical"}}/>
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>setEditingDiffItem(null)} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
                      <button onClick={()=>{const e={...diffEdits};if(editingDiffItem.name.trim()||editingDiffItem.remark.trim()){e[editingDiffItem.key]={name:editingDiffItem.name.trim(),remark:editingDiffItem.remark.trim()};}else{delete e[editingDiffItem.key];}setDiffEdits(e);setEditingDiffItem(null);}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>{t("actions.save")}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// PDF thumbnail — renders page 1 to canvas for list preview
function PdfThumb({url}){
  const ref=useRef();
  useEffect(()=>{
    if(!window.pdfjsLib||!ref.current)return;
    const pdfjsLib=window.pdfjsLib;
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    let cancelled=false;
    pdfjsLib.getDocument(url).promise.then(doc=>doc.getPage(1)).then(page=>{
      if(cancelled)return;
      const viewport=page.getViewport({scale:1.5});
      const canvas=ref.current;
      canvas.width=viewport.width;canvas.height=viewport.height;
      page.render({canvasContext:canvas.getContext('2d'),viewport});
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[url]);
  return <canvas ref={ref} style={{width:"100%",display:"block",background:"#f8f8f6"}}/>;
}

function DrawingViewer({drawing,onClose,company,currentProject,member,defects,onSaveEntry}){
  const[pins,setPins]=useState([]);const[loading,setLoading]=useState(true);
  const[placing,setPlacing]=useState(false);const[linkEntry,setLinkEntry]=useState(null);
  const[quickCreate,setQuickCreate]=useState(false);
  const[qTitle,setQTitle]=useState("");const[qSev,setQSev]=useState("Major");const[qSaving,setQSaving]=useState(false);
  const qPhotoRef=useRef();const[qPhoto,setQPhoto]=useState(null);
  const[scale,setScale]=useState(1);const[offset,setOffset]=useState({x:0,y:0});
  const[pdfPageCount,setPdfPageCount]=useState(0);const[currentPage,setCurrentPage]=useState(1);
  const[pdfLoading,setPdfLoading]=useState(false);const[pdfError,setPdfError]=useState(null);
  // Heatmap + drawing markup state
  const[showHeatmap,setShowHeatmap]=useState(false);
  const[markupMode,setMarkupMode]=useState(false);const[markupTool,setMarkupTool]=useState("freehand");
  const[markupLineStyle,setMarkupLineStyle]=useState("solid");
  const[markupColor,setMarkupColor]=useState("#ff3b30");const[markupStrokes,setMarkupStrokes]=useState(()=>getDrawingMarkup(drawing.id));
  const[markupTextSize,setMarkupTextSize]=useState(2.4);
  const[markupTextAlign,setMarkupTextAlign]=useState("left");
  const[markupTextValign,setMarkupTextValign]=useState("bottom");
  const[showDvSizeMenu,setShowDvSizeMenu]=useState(false);const dvSizeTimer=useRef();
  const[showDvAlignMenu,setShowDvAlignMenu]=useState(false);const dvAlignTimer=useRef();
  const setMarkupTextSizeBoth=(size)=>{
    setMarkupTextSize(size);
    if(markupSelectedIdx!=null){const s=markupStrokes[markupSelectedIdx];if(s?.type==="text")setMarkupStrokes(strokes=>strokes.map((st,i)=>i===markupSelectedIdx?{...st,fontSize:size}:st));}
  };
  const setMarkupTextAnchor=(v,h)=>{
    setMarkupTextValign(v);setMarkupTextAlign(h);
    if(markupSelectedIdx!=null){const s=markupStrokes[markupSelectedIdx];if(s?.type==="text")setMarkupStrokes(strokes=>strokes.map((st,i)=>i===markupSelectedIdx?{...st,align:h,valign:v}:st));}
  };
  const[markupCurrent,setMarkupCurrent]=useState(null);
  const[markupRedoStack,setMarkupRedoStack]=useState([]);
  const[dvPolylinePoints,setDvPolylinePoints]=useState([]);
  const[dvPolylineClosed,setDvPolylineClosed]=useState(false);
  const[dvStampType,setDvStampType]=useState("APPROVED");
  const[showDvStampMenu,setShowDvStampMenu]=useState(false);
  const[dvCalloutStroke,setDvCalloutStroke]=useState(null);
  const[dvCalloutText,setDvCalloutText]=useState("");
  const DV_STAMP_PRESETS=["APPROVED","REJECTED","REVIEWED","HOLD","FOR CONSTRUCTION","PRELIMINARY","DRAFT","SUPERSEDED","NOT FOR CONSTRUCTION"];
  const addMarkupStroke=(s)=>{setMarkupStrokes(prev=>[...prev,s]);setMarkupRedoStack([]);};
  // Photo placement + selection state
  const[pendingPhoto,setPendingPhoto]=useState(null); // {dataUrl, aspect}
  const[photoPlaceRect,setPhotoPlaceRect]=useState(null); // {x,y,w,h} during drag
  const[markupSelectedIdx,setMarkupSelectedIdx]=useState(null);
  const photoDragRef=useRef(null); // {mode:'move'|'resize', startPos, orig}
  const itemDragRef=useRef(null);  // {startPos, orig} — drag any selected item

  // Translate any markup stroke by (dx,dy) in percentage units.
  // Works for all geometry types: freehand, highlight, polyline, text, stamp,
  // line/arrow/rect/circle/dimension/cloud (start+end), callout (start+end),
  // and photo (pos + w/h unchanged). Returns a new stroke; does not mutate.
  const translateStroke=(s,dx,dy)=>{
    if(!s)return s;
    const n={...s};
    if(s.points)n.points=s.points.map(p=>({x:p.x+dx,y:p.y+dy}));
    if(s.start)n.start={x:s.start.x+dx,y:s.start.y+dy};
    if(s.end)n.end={x:s.end.x+dx,y:s.end.y+dy};
    if(s.pos)n.pos={x:s.pos.x+dx,y:s.pos.y+dy};
    return n;
  };
  const[showDvColorMenu,setShowDvColorMenu]=useState(false);const dvColorTimer=useRef(null);
  const[notes,setNotes]=useState([]);
  const[pendingNotePos,setPendingNotePos]=useState(null);
  const[noteText,setNoteText]=useState("");
  const[pendingTextPos,setPendingTextPos]=useState(null);
  const[pendingTextValue,setPendingTextValue]=useState("");
  const submitMarkupText=()=>{
    if(!pendingTextPos||!pendingTextValue.trim())return;
    addMarkupStroke({type:"text",color:markupColor,pos:pendingTextPos,text:pendingTextValue.trim(),fontSize:markupTextSize,align:markupTextAlign,valign:markupTextValign});
    setPendingTextPos(null);setPendingTextValue("");
  };
  const[pendingDimStroke,setPendingDimStroke]=useState(null);
  const[dimLabel,setDimLabel]=useState("");
  const[showCombinedList,setShowCombinedList]=useState(false);
  const markupSvgRef=useRef();
  const imgRef=useRef();const containerRef=useRef();const canvasRef=useRef();const pdfDocRef=useRef(null);
  const canPin=["Admin","Manager","Inspector"].includes(member?.role);
  const fileUrl=DB.fileUrl("drawings",drawing.id,drawing.file);
  const isImage=/\.(jpg|jpeg|png|gif|webp)$/i.test(drawing.file);
  const isPdf=/\.pdf$/i.test(drawing.file);

  // Real-time pin subscription
  useEffect(()=>{
    return DB.pins.subscribe(`drawingId="${drawing.id}"`,items=>{setPins(items);setLoading(false);});
  },[drawing.id]);

  // Load and persist text notes per drawing
  useEffect(()=>{
    setNotes(getDrawingNotes(drawing.id));
  },[drawing.id]);
  useEffect(()=>{
    saveDrawingNotes(drawing.id,notes);
  },[drawing.id,notes]);
  // Persist markup strokes
  useEffect(()=>{
    saveDrawingMarkup(drawing.id,markupStrokes);
  },[drawing.id,markupStrokes]);

  // Load PDF document
  useEffect(()=>{
    if(!isPdf||!window.pdfjsLib)return;
    setPdfLoading(true);setPdfError(null);
    const pdfjsLib=window.pdfjsLib;
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    pdfjsLib.getDocument(fileUrl).promise.then(doc=>{
      pdfDocRef.current=doc;
      setPdfPageCount(doc.numPages);
      setPdfLoading(false);
    }).catch(err=>{setPdfError("Failed to load PDF: "+err.message);setPdfLoading(false);});
    return()=>{if(pdfDocRef.current){pdfDocRef.current.destroy();pdfDocRef.current=null;}};
  },[isPdf,fileUrl]);

  // Render current PDF page to canvas
  useEffect(()=>{
    if(!pdfDocRef.current||!canvasRef.current)return;
    let cancelled=false;
    pdfDocRef.current.getPage(currentPage).then(page=>{
      if(cancelled)return;
      const viewport=page.getViewport({scale:2});
      const canvas=canvasRef.current;
      canvas.width=viewport.width;canvas.height=viewport.height;
      const ctx=canvas.getContext('2d');
      page.render({canvasContext:ctx,viewport}).promise.then(()=>{}).catch(()=>{});
    });
    return()=>{cancelled=true;};
  },[currentPage,pdfPageCount]);

  // Get defect info for a pin
  const getDefect=entryId=>defects.find(d=>d.id===entryId);

  // Filter pins for current page
  const pagePins=isPdf?pins.filter(p=>(p.pageNum||1)===currentPage):pins;
  const pageNotes=isPdf?notes.filter(n=>(n.pageNum||1)===currentPage):notes;

  // Handle tap on drawing to place pin or dismiss tooltip
  const handleDrawingClick=e=>{
    if(viewMode)return;
    // Dismiss active pin tooltip but DON'T stop placing — if the user is in
    // pin-drop mode, a stray active tooltip shouldn't swallow their first tap.
    if(activePin){setActivePin(null);if(!placing)return;}
    if(!placing)return;
    const target=isImage?imgRef.current:canvasRef.current;
    if(!target){alert("Drawing not ready — wait for it to load, then try again.");return;}
    const rect=target.getBoundingClientRect();
    if(!rect.width||!rect.height){alert("Drawing not loaded yet — wait a moment and try again.");return;}
    const x=((e.clientX-rect.left)/rect.width*100).toFixed(2);
    const y=((e.clientY-rect.top)/rect.height*100).toFixed(2);
    setLinkEntry({x:parseFloat(x),y:parseFloat(y),pageNum:currentPage});
    setPlacing(false);
  };

  // Save pin linked to entry (subscription auto-updates pins list)
  const savePin=async(entryId)=>{
    if(!linkEntry)return;
    try{
      await DB.pins.create({drawingId:drawing.id,entryId,pageNum:linkEntry.pageNum||1,x:linkEntry.x,y:linkEntry.y,label:""});
    }catch(e){alert("Failed to place pin: "+e.message);}
    setLinkEntry(null);
  };

  // Delete pin (subscription auto-updates pins list)
  const deletePin=async id=>{
    await DB.pins.delete(id);
  };

  // Move pin — persist new x/y percentages
  const movePin=async(id,x,y)=>{
    try{await DB.pins.update(id,{x,y});}catch(e){console.warn("pin move failed",e);}
  };

  // View mode — zoom/pan only, blocks pin placement & markup
  const[viewMode,setViewMode]=useState(false);

  // Zoom controls
  // Zoom around the center of the visible canvas area so content stays put
  const zoomBy=(delta)=>{
    const el=containerRef.current;
    const r=el?el.getBoundingClientRect():{width:0,height:0};
    const cx=r.width/2,cy=r.height/2;
    setScale(prev=>{
      const next=Math.min(Math.max(prev+delta,0.5),5);
      if(next===prev)return prev;
      const ratio=next/prev;
      setOffset(o=>({x:cx-(cx-o.x)*ratio,y:cy-(cy-o.y)*ratio}));
      return next;
    });
  };
  const zoomIn=()=>zoomBy(0.3);
  const zoomOut=()=>zoomBy(-0.3);
  const resetZoom=()=>{setScale(1);setOffset({x:0,y:0});};

  // Mouse-wheel zoom at cursor position (desktop) — attached via useEffect for {passive:false}
  const wheelHandler=useRef(null);
  wheelHandler.current=e=>{
    e.preventDefault();
    const container=containerRef.current;if(!container)return;
    const rect=container.getBoundingClientRect();
    const cx=e.clientX-rect.left;
    const cy=e.clientY-rect.top;
    const factor=e.deltaY<0?1.12:1/1.12;
    setScale(prev=>{
      const next=Math.min(Math.max(prev*factor,0.5),5);
      const ratio=next/prev;
      setOffset(o=>({x:cx-(cx-o.x)*ratio,y:cy-(cy-o.y)*ratio}));
      return next;
    });
  };
  useEffect(()=>{
    const el=containerRef.current;if(!el)return;
    const handler=e=>wheelHandler.current(e);
    el.addEventListener("wheel",handler,{passive:false});
    return()=>el.removeEventListener("wheel",handler);
  },[]);

  // Page navigation
  const prevPage=()=>setCurrentPage(p=>Math.max(1,p-1));
  const nextPage=()=>setCurrentPage(p=>Math.min(pdfPageCount,p+1));

  // Double-tap to reset zoom
  const lastTapRef=useRef(0);
  const handleDoubleTap=()=>{
    const now=Date.now();
    if(now-lastTapRef.current<300){resetZoom();lastTapRef.current=0;}
    else lastTapRef.current=now;
  };

  // Drag for panning
  // - In markup mode: only pan with 2+ fingers (single finger draws via SVG overlay)
  // - In placing mode: only pan with 2+ fingers
  // - Otherwise (view mode or normal): single finger pans
  const dragRef=useRef(null);
  const pointerCount=useRef(0);
  const onPointerDown=e=>{
    pointerCount.current++;
    if(viewMode)handleDoubleTap();
    // Second pointer lands → cancel any in-progress pan so pinch takes over cleanly
    if(pointerCount.current>=2){dragRef.current=null;return;}
    const needMultiTouch=markupMode||placing;
    if(!needMultiTouch){
      dragRef.current={startX:e.clientX-offset.x,startY:e.clientY-offset.y};
    }
  };
  const onPointerMove=e=>{
    // When 2+ fingers are down, onTouchMove handles pinch+pan; skip pointer pan to avoid jitter
    if(pointerCount.current>=2)return;
    if(dragRef.current){setOffset({x:e.clientX-dragRef.current.startX,y:e.clientY-dragRef.current.startY});}
  };
  const onPointerUp=()=>{pointerCount.current=Math.max(0,pointerCount.current-1);if(pointerCount.current===0)dragRef.current=null;};

  // Pinch-to-zoom for mobile — zooms toward pinch midpoint
  const lastPinchDist=useRef(null);
  const lastPinchMid=useRef(null);
  const onTouchMove=e=>{
    if(e.touches.length===2){
      e.preventDefault();
      const t0=e.touches[0],t1=e.touches[1];
      const dx=t0.clientX-t1.clientX,dy=t0.clientY-t1.clientY;
      const dist=Math.sqrt(dx*dx+dy*dy);
      const container=containerRef.current;
      const rect=container?container.getBoundingClientRect():{left:0,top:0};
      const mx=(t0.clientX+t1.clientX)/2-rect.left;
      const my=(t0.clientY+t1.clientY)/2-rect.top;
      if(lastPinchDist.current!==null&&lastPinchMid.current!==null){
        const factor=dist/lastPinchDist.current;
        setScale(prev=>{
          const next=Math.min(Math.max(prev*factor,0.5),5);
          const ratio=next/prev;
          setOffset(o=>({x:mx-(mx-o.x)*ratio,y:my-(my-o.y)*ratio}));
          return next;
        });
        // Two-finger pan: shift by midpoint delta
        const pmx=lastPinchMid.current.x,pmy=lastPinchMid.current.y;
        setOffset(o=>({x:o.x+(mx-pmx),y:o.y+(my-pmy)}));
      }
      lastPinchDist.current=dist;
      lastPinchMid.current={x:mx,y:my};
    }
  };
  const onTouchEnd=()=>{lastPinchDist.current=null;lastPinchMid.current=null;};

  // Drawing markup handlers
  const getMarkupPos=e=>{
    const svg=markupSvgRef.current;if(!svg)return null;
    const rect=svg.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{x:((t.clientX-rect.left)/rect.width*100),y:((t.clientY-rect.top)/rect.height*100)};
  };
  // Hit-test: find topmost photo stroke under point p (SVG % coords)
  const hitPhotoAt=p=>{
    for(let i=markupStrokes.length-1;i>=0;i--){
      const s=markupStrokes[i];
      if(s.type!=="photo"||!s.pos)continue;
      if(p.x>=s.pos.x&&p.x<=s.pos.x+s.w&&p.y>=s.pos.y&&p.y<=s.pos.y+s.h)return i;
    }
    return -1;
  };
  // Is the click in the bottom-right resize handle of stroke idx?
  const hitResizeHandle=(p,idx)=>{
    const s=markupStrokes[idx];if(!s||s.type!=="photo")return false;
    const hx=s.pos.x+s.w,hy=s.pos.y+s.h;
    return Math.abs(p.x-hx)<5&&Math.abs(p.y-hy)<5;
  };

  const onMarkupDown=e=>{
    if(!markupMode)return;
    // Two-finger gesture: abort any in-progress stroke and let the container's
    // pinch/pan handler take over — matches view-mode behavior.
    if(e.touches&&e.touches.length>=2){
      setMarkupCurrent(null);
      itemDragRef.current=null;
      photoDragRef.current=null;
      setPhotoPlaceRect(null);
      return;
    }
    e.preventDefault();e.stopPropagation();
    const p=getMarkupPos(e);if(!p)return;
    // Drag to place a pending photo (rubber-band rect)
    if(pendingPhoto){
      setPhotoPlaceRect({x:p.x,y:p.y,w:0,h:0,startX:p.x,startY:p.y});
      return;
    }
    // Select tool: select any markup stroke (photo, text, shape)
    if(markupTool==="select"){
      // First check if a corner handle of the already-selected photo is grabbed
      if(markupSelectedIdx!=null&&hitResizeHandle(p,markupSelectedIdx)){
        const s=markupStrokes[markupSelectedIdx];
        photoDragRef.current={mode:"resize",startPos:p,orig:{pos:{...s.pos},w:s.w,h:s.h}};
        return;
      }
      // Try photo first (supports drag/move)
      const photoIdx=hitPhotoAt(p);
      if(photoIdx>=0){
        setMarkupSelectedIdx(photoIdx);
        const s=markupStrokes[photoIdx];
        photoDragRef.current={mode:"move",startPos:p,orig:{pos:{...s.pos},w:s.w,h:s.h}};
        return;
      }
      // Hit-test all other strokes for selection (no drag, just select for delete)
      const hitRadius=2.5; // percentage units
      let hitIdx=-1;
      for(let i=markupStrokes.length-1;i>=0;i--){
        const s=markupStrokes[i];
        if(s.type==="text"&&s.pos){
          const fs=s.fontSize?s.fontSize*0.75:1.8;
          const tw=fs*((s.text||"").length)*0.44;
          if(p.x>=s.pos.x-1&&p.x<=s.pos.x+tw+1&&p.y>=s.pos.y-fs-1&&p.y<=s.pos.y+1){hitIdx=i;break;}
        }else if((s.type==="freehand"||s.type==="highlight")&&s.points){
          const hr=s.type==="highlight"?4:hitRadius;
          for(const pt of s.points){if(Math.abs(p.x-pt.x)<hr&&Math.abs(p.y-pt.y)<hr){hitIdx=i;break;}}
          if(hitIdx>=0)break;
        }else if(s.type==="polyline"&&s.points){
          for(const pt of s.points){if(Math.abs(p.x-pt.x)<hitRadius&&Math.abs(p.y-pt.y)<hitRadius){hitIdx=i;break;}}
          if(hitIdx>=0)break;
        }else if(s.type==="stamp"&&s.pos){
          if(Math.abs(p.x-s.pos.x)<5&&Math.abs(p.y-s.pos.y)<3){hitIdx=i;break;}
        }else if(s.type==="callout"&&s.start&&s.end){
          const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
          const hw=Math.abs(s.end.x-s.start.x)/2+hitRadius+2,hh=Math.abs(s.end.y-s.start.y)/2+hitRadius+2;
          if(Math.abs(p.x-cx)<=hw&&Math.abs(p.y-cy)<=hh){hitIdx=i;break;}
        }else if(s.start&&s.end){
          const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
          const hw=Math.abs(s.end.x-s.start.x)/2+hitRadius,hh=Math.abs(s.end.y-s.start.y)/2+hitRadius;
          if(Math.abs(p.x-cx)<=hw&&Math.abs(p.y-cy)<=hh){hitIdx=i;break;}
        }
      }
      setMarkupSelectedIdx(hitIdx>=0?hitIdx:null);
      if(hitIdx>=0){
        // Start a move drag for any selected (non-photo) item
        itemDragRef.current={startPos:p,orig:JSON.parse(JSON.stringify(markupStrokes[hitIdx]))};
      }
      return;
    }
    if(markupTool==="text"){
      setPendingTextPos(p);
      setPendingTextValue("");
      return;
    }
    if(markupTool==="polyline"){
      setDvPolylinePoints(prev=>[...prev,p]);
      return;
    }
    if(markupTool==="stamp"){
      addMarkupStroke({type:"stamp",color:markupColor,pos:p,stampId:dvStampType,text:dvStampType,fontSize:markupTextSize});
      return;
    }
    if(markupTool==="freehand")setMarkupCurrent({type:"freehand",color:markupColor,points:[p]});
    else if(markupTool==="highlight")setMarkupCurrent({type:"highlight",color:markupColor,points:[p]});
    else setMarkupCurrent({type:markupTool,color:markupColor,lineStyle:markupLineStyle,start:p,end:p});
  };
  const onMarkupMove=e=>{
    if(!markupMode)return;
    // Two-finger gesture mid-stroke: cancel the stroke so pinch/pan can run.
    if(e.touches&&e.touches.length>=2){
      if(markupCurrent)setMarkupCurrent(null);
      if(itemDragRef.current)itemDragRef.current=null;
      if(photoDragRef.current)photoDragRef.current=null;
      if(photoPlaceRect)setPhotoPlaceRect(null);
      return;
    }
    const p=getMarkupPos(e);if(!p)return;
    // Rubber-band rect while placing a new photo
    if(pendingPhoto&&photoPlaceRect){
      e.preventDefault();e.stopPropagation();
      const sx=photoPlaceRect.startX,sy=photoPlaceRect.startY;
      const x=Math.min(sx,p.x),y=Math.min(sy,p.y);
      const w=Math.abs(p.x-sx),h=Math.abs(p.y-sy);
      setPhotoPlaceRect({...photoPlaceRect,x,y,w,h});
      return;
    }
    // Move selected non-photo item
    if(itemDragRef.current&&markupSelectedIdx!=null){
      e.preventDefault();e.stopPropagation();
      const{startPos,orig}=itemDragRef.current;
      const dx=p.x-startPos.x,dy=p.y-startPos.y;
      setMarkupStrokes(strokes=>strokes.map((s,i)=>i===markupSelectedIdx?translateStroke(orig,dx,dy):s));
      return;
    }
    // Move / resize selected photo
    if(photoDragRef.current&&markupSelectedIdx!=null){
      e.preventDefault();e.stopPropagation();
      const{mode,startPos,orig}=photoDragRef.current;
      const dx=p.x-startPos.x,dy=p.y-startPos.y;
      setMarkupStrokes(strokes=>strokes.map((s,i)=>{
        if(i!==markupSelectedIdx||s.type!=="photo")return s;
        if(mode==="move"){
          return{...s,pos:{x:Math.max(0,Math.min(100-orig.w,orig.pos.x+dx)),y:Math.max(0,Math.min(100-orig.h,orig.pos.y+dy))}};
        }
        // Resize from bottom-right, preserve aspect
        const aspect=orig.h/orig.w;
        const nw=Math.max(4,Math.min(100-orig.pos.x,orig.w+dx));
        const nh=nw*aspect;
        return{...s,w:nw,h:Math.min(100-orig.pos.y,nh)};
      }));
      return;
    }
    if(!markupCurrent)return;
    e.preventDefault();e.stopPropagation();
    if(markupCurrent.type==="freehand"||markupCurrent.type==="highlight")setMarkupCurrent(c=>({...c,points:[...c.points,p]}));
    else setMarkupCurrent(c=>({...c,end:p}));
  };
  const onMarkupUp=()=>{
    // Finalise a pending photo placement
    if(pendingPhoto&&photoPlaceRect){
      let{x,y,w,h}=photoPlaceRect;
      // If drag was tiny, use a default 30%-wide centered rect
      if(w<3||h<3){
        w=30;h=30*pendingPhoto.aspect;
        x=Math.max(0,Math.min(100-w,(photoPlaceRect.startX||50)-w/2));
        y=Math.max(0,Math.min(100-h,(photoPlaceRect.startY||50)-h/2));
      }else{
        // Preserve the image's aspect based on the drawn width
        h=w*pendingPhoto.aspect;
        if(y+h>100)h=100-y;
      }
      const stroke={type:"photo",dataUrl:pendingPhoto.dataUrl,pos:{x,y},w,h};
      setMarkupStrokes(s=>{
        setMarkupSelectedIdx(s.length);
        return[...s,stroke];
      });setMarkupRedoStack([]);
      setPendingPhoto(null);setPhotoPlaceRect(null);
      setMarkupTool("select");
      return;
    }
    if(itemDragRef.current){itemDragRef.current=null;return;}
    if(photoDragRef.current){photoDragRef.current=null;return;}
    if(markupCurrent){
      if(markupCurrent.type==="dimension"){
        // Hold the dimension stroke and ask for label
        setPendingDimStroke(markupCurrent);setDimLabel("");setMarkupCurrent(null);
        return;
      }
      if(markupCurrent.type==="callout"){
        setDvCalloutStroke(markupCurrent);setDvCalloutText("");setMarkupCurrent(null);
        return;
      }
      addMarkupStroke(markupCurrent);setMarkupCurrent(null);
    }
  };
  const finishDvPolyline=()=>{
    if(dvPolylinePoints.length>1){
      addMarkupStroke({type:"polyline",color:markupColor,points:[...dvPolylinePoints],closed:dvPolylineClosed,lineStyle:markupLineStyle});
    }
    setDvPolylinePoints([]);
  };
  const undoMarkup=()=>{setMarkupStrokes(s=>{if(!s.length)return s;setMarkupRedoStack(r=>[...r,s[s.length-1]]);return s.slice(0,-1);});};
  const redoMarkup=()=>{setMarkupRedoStack(r=>{if(!r.length)return r;const item=r[r.length-1];setMarkupStrokes(s=>[...s,item]);return r.slice(0,-1);});};
  const clearMarkup=()=>{if(markupStrokes.length&&confirm(t("markup.clear_markup")))setMarkupStrokes([]);};

  // Photo overlay — pick/capture an image, compress, then enter "drag to place" mode
  const markupPhotoRef=useRef();
  const handleMarkupPhotoFile=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    e.target.value="";
    const img=new Image();
    img.onload=()=>{
      const maxDim=1200;
      const sc=Math.min(1,maxDim/Math.max(img.width,img.height));
      const cw=Math.round(img.width*sc),ch=Math.round(img.height*sc);
      const cnv=document.createElement("canvas");
      cnv.width=cw;cnv.height=ch;
      const ctx2=cnv.getContext("2d");
      ctx2.drawImage(img,0,0,cw,ch);
      const dataUrl=cnv.toDataURL("image/jpeg",0.82);
      setPendingPhoto({dataUrl,aspect:ch/cw});
      setMarkupSelectedIdx(null);
    };
    img.onerror=()=>alert("Could not load image.");
    const reader=new FileReader();
    reader.onload=ev=>{img.src=ev.target.result;};
    reader.readAsDataURL(file);
  };
  const cancelPendingPhoto=()=>{setPendingPhoto(null);setPhotoPlaceRect(null);};
  const deleteSelectedMarkup=()=>{
    if(markupSelectedIdx==null)return;
    setMarkupStrokes(s=>s.filter((_,i)=>i!==markupSelectedIdx));
    setMarkupSelectedIdx(null);
  };
  // Scale the currently selected item by a multiplier.
  // - photo: resizes w/h (preserves aspect, clamps to page)
  // - text / callout / stamp: bumps fontSize
  // - line / arrow / rect / circle / dimension / cloud: scales start↔end around midpoint
  // - freehand / highlight / polyline: scales points around their centroid
  const scaleSelectedPhoto=(mult)=>{
    if(markupSelectedIdx==null)return;
    setMarkupStrokes(strokes=>strokes.map((s,i)=>{
      if(i!==markupSelectedIdx)return s;
      if(s.type==="photo"){
        const aspect=s.h/s.w;
        const nw=Math.max(5,Math.min(100-s.pos.x,s.w*mult));
        const nh=Math.min(100-s.pos.y,nw*aspect);
        return{...s,w:nw,h:nh};
      }
      if(s.type==="text"||s.type==="callout"||s.type==="stamp"){
        const cur=s.fontSize||2.4;
        return{...s,fontSize:Math.max(0.8,Math.min(12,cur*mult))};
      }
      if(s.start&&s.end){
        const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
        return{...s,
          start:{x:cx+(s.start.x-cx)*mult,y:cy+(s.start.y-cy)*mult},
          end  :{x:cx+(s.end.x  -cx)*mult,y:cy+(s.end.y  -cy)*mult},
        };
      }
      if(s.points&&s.points.length){
        const cx=s.points.reduce((a,p)=>a+p.x,0)/s.points.length;
        const cy=s.points.reduce((a,p)=>a+p.y,0)/s.points.length;
        return{...s,points:s.points.map(p=>({x:cx+(p.x-cx)*mult,y:cy+(p.y-cy)*mult}))};
      }
      return s;
    }));
  };

  const addNote=()=>{
    if(!pendingNotePos||!noteText.trim())return;
    const note={
      id:`note_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      drawingId:drawing.id,
      pageNum:isPdf?(pendingNotePos.pageNum||currentPage):1,
      x:pendingNotePos.x,
      y:pendingNotePos.y,
      text:noteText.trim(),
      createdBy:member?.name||"",
      createdAt:Date.now()
    };
    setNotes(prev=>[note,...prev]);
    setPendingNotePos(null);setNoteText("");
  };

  const deleteNote=id=>setNotes(prev=>prev.filter(n=>n.id!==id));

  // Render SVG markup strokes
  const renderMarkupSvg=(strokes)=>strokes.map((s,i)=>{
    const dash=s.lineStyle==="dotted"?"0.8 0.6":undefined;
    if(s.type==="freehand"&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={s.color} strokeWidth="0.3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
    }else if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      const angle=Math.atan2(dy,dx),hl=1.5;
      return <g key={i}><line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.3" strokeDasharray={dash}/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle-0.4)*1.5} y2={s.end.y-hl*Math.sin(angle-0.4)*1.5} stroke={s.color} strokeWidth="0.3"/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle+0.4)*1.5} y2={s.end.y-hl*Math.sin(angle+0.4)*1.5} stroke={s.color} strokeWidth="0.3"/></g>;
    }else if(s.type==="circle"&&s.start&&s.end){
      const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      if(rx<0.3&&ry<0.3)return null;
      return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={s.color} strokeWidth="0.3" fill="none" strokeDasharray={dash}/>;
    }else if(s.type==="rect"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w<0.3&&h<0.3)return null;
      return <rect key={i} x={x} y={y} width={w} height={h} stroke={s.color} strokeWidth="0.3" fill="none" strokeDasharray={dash}/>;
    }else if(s.type==="line"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.3)return null;
      return <line key={i} x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.3" strokeDasharray={dash}/>;
    }else if(s.type==="dimension"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      // Perpendicular tick direction
      const nx=-dy/len*1.2,ny=dx/len*1.2;
      const mx=(s.start.x+s.end.x)/2,my=(s.start.y+s.end.y)/2;
      const angle=Math.atan2(dy,dx)*180/Math.PI;
      const label=s.label||"";
      return <g key={i}>
        <line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.2" strokeDasharray={dash}/>
        {/* End ticks */}
        <line x1={s.start.x+nx} y1={s.start.y+ny} x2={s.start.x-nx} y2={s.start.y-ny} stroke={s.color} strokeWidth="0.3"/>
        <line x1={s.end.x+nx} y1={s.end.y+ny} x2={s.end.x-nx} y2={s.end.y-ny} stroke={s.color} strokeWidth="0.3"/>
        {label&&<text x={mx} y={my} fill={s.color} fontSize="2.2" fontFamily="'Barlow Condensed',sans-serif" fontWeight="700" textAnchor="middle" dominantBaseline="central" transform={`rotate(${angle>90||angle<-90?angle+180:angle},${mx},${my})`} dy="-1">{label}</text>}
      </g>;
    }else if(s.type==="text"&&s.pos&&s.text){
      const fs=s.fontSize?Math.max(0.8,s.fontSize*0.75):1.8;
      const isSel=markupSelectedIdx===i;
      const align=s.align||"left";
      const valign=s.valign||"bottom";
      const anchor=align==="center"?"middle":(align==="right"?"end":"start");
      const dy=valign==="top"?fs:(valign==="middle"?fs*0.4:0);
      return <g key={i}>
        <rect x={s.pos.x-(align==="center"?fs*s.text.length*0.22:(align==="right"?fs*s.text.length*0.44:0))-0.3} y={s.pos.y-dy-0.3} width={Math.max(2,fs*s.text.length*0.44)+0.6} height={fs*1.3+0.6} fill="rgba(255,255,255,0.92)" stroke={isSel?"#5856d6":s.color} strokeWidth={isSel?"0.4":"0.2"} rx="0.4"/>
        <text x={s.pos.x} y={s.pos.y-dy+fs} fill={s.color} fontSize={fs} fontFamily="'Barlow Condensed',sans-serif" fontWeight="700" textAnchor={anchor}>{s.text}</text>
      </g>;
    }else if(s.type==="cloud"&&s.start&&s.end){
      const x=Math.min(s.start.x,s.end.x),y=Math.min(s.start.y,s.end.y);
      const w=Math.abs(s.end.x-s.start.x),h=Math.abs(s.end.y-s.start.y);
      if(w<0.3&&h<0.3)return null;
      const arcsPerW=Math.max(4,Math.round(w/3)),arcsPerH=Math.max(4,Math.round(h/3));
      const dw=w/arcsPerW,dh=h/arcsPerH,r=Math.max(dw,dh)*0.55;
      let d="";
      for(let j=0;j<arcsPerW;j++){const cx=x+dw*j+dw/2;d+=`M${cx-dw/2},${y} A${r},${r} 0 0,1 ${cx+dw/2},${y} `;}
      for(let j=0;j<arcsPerH;j++){const cy=y+dh*j+dh/2;d+=`M${x+w},${cy-dh/2} A${r},${r} 0 0,1 ${x+w},${cy+dh/2} `;}
      for(let j=arcsPerW-1;j>=0;j--){const cx=x+dw*j+dw/2;d+=`M${cx+dw/2},${y+h} A${r},${r} 0 0,1 ${cx-dw/2},${y+h} `;}
      for(let j=arcsPerH-1;j>=0;j--){const cy=y+dh*j+dh/2;d+=`M${x},${cy+dh/2} A${r},${r} 0 0,1 ${x},${cy-dh/2} `;}
      return <path key={i} d={d} stroke={s.color} strokeWidth="0.3" fill="none"/>;
    }else if(s.type==="callout"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      const angle=Math.atan2(dy,dx),hl=1.5;
      const fs=s.fontSize?Math.max(0.8,s.fontSize*0.75):1.8;
      const text=s.text||"";
      const tw=text.length*fs*0.44;
      return <g key={i}>
        <line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.3" strokeDasharray={dash}/>
        <line x1={s.start.x} y1={s.start.y} x2={s.start.x+hl*Math.cos(angle-0.4)*1.5} y2={s.start.y+hl*Math.sin(angle-0.4)*1.5} stroke={s.color} strokeWidth="0.3"/>
        <line x1={s.start.x} y1={s.start.y} x2={s.start.x+hl*Math.cos(angle+0.4)*1.5} y2={s.start.y+hl*Math.sin(angle+0.4)*1.5} stroke={s.color} strokeWidth="0.3"/>
        {text&&<><rect x={s.end.x-0.3} y={s.end.y-fs-0.3} width={tw+0.6} height={fs+0.6} rx="0.3" fill="rgba(255,255,255,0.92)" stroke={s.color} strokeWidth="0.2"/><text x={s.end.x} y={s.end.y} fill={s.color} fontSize={fs} fontFamily="'Barlow Condensed',sans-serif" fontWeight="700">{text}</text></>}
      </g>;
    }else if(s.type==="highlight"&&s.points&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={s.color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.3"/>;
    }else if(s.type==="polyline"&&s.points&&s.points.length>1){
      const pts=s.points.map(p=>`${p.x},${p.y}`).join(" ");
      if(s.closed)return <polygon key={i} points={pts} stroke={s.color} strokeWidth="0.3" fill="none" strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round"/>;
      return <polyline key={i} points={pts} stroke={s.color} strokeWidth="0.3" fill="none" strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round"/>;
    }else if(s.type==="stamp"&&s.pos){
      const text=s.text||s.stampId||"STAMP";
      const fs=s.fontSize?Math.max(0.8,s.fontSize*0.75):2.2;
      const tw=text.length*fs*0.5;
      const pad=fs*0.4;
      const stampColor=s.stampId==="APPROVED"?"#34c759":s.stampId==="REJECTED"?"#ff3b30":s.stampId==="REVIEWED"?"#007aff":s.color||"#ff9500";
      return <g key={i} transform={`rotate(-15,${s.pos.x},${s.pos.y})`}>
        <rect x={s.pos.x-tw/2-pad} y={s.pos.y-fs/2-pad} width={tw+pad*2} height={fs+pad*2} fill="none" stroke={stampColor} strokeWidth="0.25"/>
        <text x={s.pos.x} y={s.pos.y} fill={stampColor} fontSize={fs} fontFamily="Arial,sans-serif" fontWeight="700" textAnchor="middle" dominantBaseline="central" opacity="0.85">{text}</text>
      </g>;
    }else if(s.type==="photo"&&s.pos&&s.dataUrl){
      const isSel=markupSelectedIdx===i;
      return <g key={i}>
        <image href={s.dataUrl} x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} preserveAspectRatio="xMidYMid meet"/>
        <rect x={s.pos.x} y={s.pos.y} width={s.w} height={s.h} fill="none" stroke={isSel?"#5856d6":"rgba(255,255,255,0.85)"} strokeWidth={isSel?"0.5":"0.25"} strokeDasharray={isSel?"1 0.6":undefined}/>
        {isSel&&<>
          {/* Larger, high-contrast drag-corner handle with a clear ↘ affordance */}
          <circle cx={s.pos.x+s.w} cy={s.pos.y+s.h} r="3.4" fill="#5856d6" stroke="#fff" strokeWidth="0.7"/>
          <path d={`M${s.pos.x+s.w-1.5} ${s.pos.y+s.h-1.5} L${s.pos.x+s.w+1.5} ${s.pos.y+s.h+1.5} M${s.pos.x+s.w+0.2} ${s.pos.y+s.h-1.5} L${s.pos.x+s.w+1.5} ${s.pos.y+s.h-1.5} L${s.pos.x+s.w+1.5} ${s.pos.y+s.h-0.2} M${s.pos.x+s.w-1.5} ${s.pos.y+s.h+0.2} L${s.pos.x+s.w-1.5} ${s.pos.y+s.h+1.5} L${s.pos.x+s.w-0.2} ${s.pos.y+s.h+1.5}`} stroke="#fff" strokeWidth="0.55" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </>}
      </g>;
    }
    return null;
  });

  // Heatmap overlay — radial gradients per pin, weighted by severity
  const renderHeatmap=()=>{
    if(!showHeatmap||pagePins.length===0)return null;
    const sevWeight={Critical:1,Major:0.7,Minor:0.4,Observation:0.2};
    return(
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none",opacity:0.55,mixBlendMode:"multiply"}}>
        <defs>
          {pagePins.map((p,i)=>{
            const d=getDefect(p.entryId);
            const w=sevWeight[d?.severity]||0.3;
            const color=d?SEV_COLOR[d.severity]||"#ff6b00":"#8e8e93";
            return(
              <radialGradient key={i} id={`hg${i}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={color} stopOpacity={w}/>
                <stop offset="100%" stopColor={color} stopOpacity="0"/>
              </radialGradient>
            );
          })}
        </defs>
        {pagePins.map((p,i)=>(
          <circle key={i} cx={p.x} cy={p.y} r="8" fill={`url(#hg${i})`}/>
        ))}
      </svg>
    );
  };

  // Active pin tooltip (tap to show/hide)
  const[activePin,setActivePin]=useState(null);

  const renderNotes=()=>pageNotes.map(n=>(
    <div key={n.id} style={{position:"absolute",left:`${n.x}%`,top:`${n.y}%`,transform:"translate(-50%,-50%)",zIndex:8,pointerEvents:"none"}}>
      <div style={{display:"flex",alignItems:"center",gap:4,background:"rgba(88,86,214,0.9)",border:"1px solid rgba(255,255,255,0.35)",borderRadius:8,padding:"2px 6px",maxWidth:170,boxShadow:"0 2px 8px rgba(0,0,0,0.35)"}}>
        <span style={{fontSize:10}}>📝</span>
        <span style={{fontSize:10,color:"#fff",fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{n.text}</span>
      </div>
    </div>
  ));

  const combinedItems=[
    ...pagePins.map(p=>{
      const d=getDefect(p.entryId);
      return{kind:"pin",id:p.id,x:p.x,y:p.y,pageNum:p.pageNum||1,title:d?.title||"Linked entry",severity:d?.severity||"—",status:d?.status||"—",detail:d?.location||"",createdAt:0};
    }),
    ...pageNotes.map(n=>({kind:"note",id:n.id,x:n.x,y:n.y,pageNum:n.pageNum||1,title:n.text,severity:"NOTE",status:"",detail:n.createdBy||"",createdAt:n.createdAt||0})),
    ...markupStrokes.map((s,i)=>({kind:"markup",id:`markup_${i}`,x:s.start?.x||s.points?.[0]?.x||s.pos?.x||0,y:s.start?.y||s.points?.[0]?.y||s.pos?.y||0,pageNum:1,title:s.type==="text"?s.text:`${s.type} (${s.color})`,severity:"MARKUP",status:s.type,detail:s.color,createdAt:0}))
  ].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));

  const exportDrawingCsv=()=>{
    const header=["Type","Title","Severity/Category","Status","Location","Position","Drawing","Project"];
    const rows=combinedItems.map(item=>[item.kind.toUpperCase(),item.title,item.severity,item.status||"",item.detail||"",`(${Math.round(item.x)},${Math.round(item.y)})`,drawing.name,currentProject?.name||""]);
    const csv=[header,...rows].map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${fileTimestamp()}-${drawing.name.replace(/\W+/g,"_")}_annotations.csv`;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  const exportDrawingPdf=async()=>{
    const stamp=new Date().toLocaleString();
    const itemsHtml=combinedItems.length?combinedItems.map((item,i)=>`<tr><td>${i+1}</td><td style="color:${item.kind==="pin"?"#ff3b30":item.kind==="note"?"#5856d6":"#ff6b00"};font-weight:700">${item.kind.toUpperCase()}</td><td>${sanitize(item.title)}</td><td>${sanitize(item.severity)}</td><td>${sanitize(item.detail||"")}</td></tr>`).join(""):`<tr><td colspan="5" style="text-align:center;color:#999">No annotations</td></tr>`;
    const w=window.open("","_blank");
    if(!w){alert("Popup blocked.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-${sanitize(drawing.name)}_annotations</title></head><body style="font-family:Arial,sans-serif;padding:40px;text-align:center;color:#888">Rendering annotated drawing… please wait.</body></html>`);
    w.document.close();
    let pagesHtml="";
    try{
      const pages=await renderDrawingAnnotatedPages(drawing,defects,pins.map(p=>({...p,drawingId:drawing.id})));
      pagesHtml=pages.length?pages.map(pg=>`<div style="margin:8px 0;page-break-inside:avoid"><div style="font-size:10px;color:#888;margin-bottom:3px">Page ${pg.pageNum}</div><img src="${pg.dataUrl}" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/></div>`).join(""):`<div style="font-size:11px;color:#999;padding:8px;border:1px dashed #ddd;border-radius:6px">Drawing preview unavailable.</div>`;
    }catch(e){console.warn(e);pagesHtml=`<div style="font-size:11px;color:#999">Drawing preview unavailable.</div>`;}
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-${sanitize(drawing.name)}_annotations</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111;max-width:900px;margin:0 auto}h1{margin:0 0 4px;font-size:20px}h2{margin:18px 0 8px;font-size:15px;border-bottom:2px solid #ddd;padding-bottom:4px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f5f5f5;text-align:left}.meta{font-size:12px;color:#444;margin-bottom:4px}@media print{.no-print{display:none}}</style></head><body><h1>Drawing Annotations — ${sanitize(drawing.name)}</h1><div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")} | <b>Generated:</b> ${sanitize(stamp)}</div><div class="meta"><b>Total:</b> ${combinedItems.length} items (${combinedItems.filter(i=>i.kind==="pin").length} pins, ${combinedItems.filter(i=>i.kind==="note").length} notes, ${combinedItems.filter(i=>i.kind==="markup").length} markups)</div><h2>📐 Annotated Drawing</h2>${pagesHtml}<h2>📋 Annotation Details</h2><table><tr><th>#</th><th>Type</th><th>Title / Content</th><th>Category</th><th>Detail</th></tr>${itemsHtml}</table><button class="no-print" onclick="window.print()">Print / Save as PDF</button><script>window.onload=function(){setTimeout(function(){window.print();},400);};</script></body></html>`);
    w.document.close();
  };

  // Shared pin overlay
  const renderPins=()=>pagePins.map(p=>{
    const d=getDefect(p.entryId);
    const color=d?SEV_COLOR[d.severity]||"#ff6b00":"#8e8e93";
    const isActive=activePin===p.id;
    const isCritical=d?.severity==="Critical";
    const isOpen=d?.status==="Open";
    const onPinPointerDown=e=>{
      if(!canPin||viewMode)return;
      const target=isImage?imgRef.current:canvasRef.current;
      if(!target)return;
      e.stopPropagation();e.preventDefault();
      const pinEl=e.currentTarget;
      const startRect=target.getBoundingClientRect();
      let moved=false;
      const onMove=ev=>{
        const x=((ev.clientX-startRect.left)/startRect.width)*100;
        const y=((ev.clientY-startRect.top)/startRect.height)*100;
        if(x<0||x>100||y<0||y>100)return;
        moved=true;
        pinEl.style.left=x+"%";pinEl.style.top=y+"%";
      };
      const onUp=ev=>{
        document.removeEventListener("pointermove",onMove);
        document.removeEventListener("pointerup",onUp);
        document.removeEventListener("pointercancel",onUp);
        try{pinEl.releasePointerCapture?.(ev.pointerId);}catch{}
        if(!moved){setActivePin(isActive?null:p.id);return;}
        // Persist final position
        const rect=target.getBoundingClientRect();
        const x=Math.max(0,Math.min(100,((ev.clientX-rect.left)/rect.width)*100));
        const y=Math.max(0,Math.min(100,((ev.clientY-rect.top)/rect.height)*100));
        movePin(p.id,parseFloat(x.toFixed(2)),parseFloat(y.toFixed(2)));
      };
      try{pinEl.setPointerCapture?.(e.pointerId);}catch{}
      document.addEventListener("pointermove",onMove);
      document.addEventListener("pointerup",onUp);
      document.addEventListener("pointercancel",onUp);
    };
    return(
      <div key={p.id} style={{position:"absolute",left:`${p.x}%`,top:`${p.y}%`,transform:"translate(-50%,-50%)",zIndex:isActive?15:5,cursor:canPin&&!viewMode?"move":"pointer",touchAction:"none"}}
        onPointerDown={onPinPointerDown}
        title={canPin&&!viewMode?"Drag to move, click to view":"Click to view"}
        onClick={e=>{e.stopPropagation();}}>
        <div style={{position:"relative",width:32,height:32}}>
          {/* Pulse ring for Critical/Open */}
          {isCritical&&isOpen&&<div style={{position:"absolute",top:"50%",left:"50%",width:32,height:32,borderRadius:"50%",background:color,animation:"sevPulse 2s ease-in-out infinite"}}/>}
          {/* Outer ring */}
          <div style={{position:"absolute",inset:0,borderRadius:"50%",border:`3px solid ${color}`,background:isActive?"rgba(255,255,255,0.15)":"rgba(0,0,0,0.4)",boxShadow:isActive?`0 0 12px ${color}`:"0 2px 6px rgba(0,0,0,0.4)"}}/>
          {/* Inner dot */}
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:12,height:12,borderRadius:"50%",background:color}}/>
          {/* Severity initial */}
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:900,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",textShadow:"0 1px 2px rgba(0,0,0,0.8)"}}>{d?.severity?d.severity[0]:""}</div>
          {isActive&&(
            <div style={{position:"absolute",bottom:38,left:"50%",transform:"translateX(-50%)",background:"#1a1a1a",borderRadius:10,padding:"10px 14px",minWidth:180,zIndex:20,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",border:`1px solid ${color}30`}}>
              {d?(<>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:color,flexShrink:0}}/>
                  <div style={{fontSize:12,fontWeight:700,color:"#fff"}}>{d.title}</div>
                </div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:6}}>{d.severity} · {d.status}{d.assignee?` · ${d.assignee}`:""}</div>
              </>):(<div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:6}}>Entry not found</div>)}
              {canPin&&<button onClick={e=>{e.stopPropagation();deletePin(p.id);setActivePin(null);}} style={{width:"100%",background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:6,padding:"6px 10px",color:"#ff6b6b",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>REMOVE PIN</button>}
            </div>
          )}
        </div>
      </div>
    );
  });

  return(
    <div style={{position:"fixed",inset:0,background:"#1a1a1a",zIndex:250,display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{background:"#1a1a1a",padding:"12px 14px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0,flexWrap:"wrap"}}>
        <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
        <div style={{flex:1,minWidth:80}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{drawing.name}</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>{pins.length} pin(s){isPdf&&pdfPageCount>0?` · Page ${currentPage}/${pdfPageCount}`:""}</div>
        </div>
        <button onClick={()=>{setViewMode(v=>!v);if(!viewMode){setPlacing(false);setMarkupMode(false);}}} title="View mode — zoom & pan" style={{width:36,height:36,borderRadius:10,border:viewMode?"2px solid #2da845":"2px solid rgba(255,255,255,0.15)",background:viewMode?"rgba(52,199,89,0.25)":"rgba(255,255,255,0.08)",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>👁</button>
        {canPin&&!markupMode&&!viewMode&&(
          <button onClick={()=>{setPlacing(!placing);setViewMode(false);}} style={{background:placing?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {placing?t("actions.tap_to_place"):"📌 ADD PIN"}
          </button>
        )}
        {canPin&&!placing&&!viewMode&&(
          <button onClick={()=>{setMarkupMode(!markupMode);setViewMode(false);}} style={{background:markupMode?"#5856d6":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {markupMode?"DONE":"✏ MARKUP"}
          </button>
        )}
        <button onClick={()=>setShowCombinedList(v=>!v)} style={{background:showCombinedList?"rgba(255,107,0,0.22)":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
          LIST ({combinedItems.length})
        </button>
      </div>

      {/* Placing mode indicator */}
      {placing&&!viewMode&&<div style={{background:"#ff6b00",padding:"8px 16px",textAlign:"center",color:"#fff",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",flexShrink:0}}>TAP ON THE DRAWING TO PLACE A PIN</div>}
      {viewMode&&<div style={{background:"#34c759",padding:"6px 16px",textAlign:"center",color:"#fff",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",flexShrink:0}}>VIEW MODE — pinch or scroll to zoom · drag to pan · tap VIEW to exit</div>}

      {/* Markup toolbar */}
      {markupMode&&(
        <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:6,background:"#1a1a1a",borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0,flexWrap:"wrap"}}>
          <button onClick={()=>setMarkupMode(false)} title="Exit markup mode" style={{padding:"6px 12px",borderRadius:8,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",boxShadow:"0 1px 4px rgba(88,86,214,0.35)"}}>✓ DONE</button>
          {[{id:"select",label:null,title:"Select, move, resize"},{id:"freehand",label:"✏",title:"Freehand"},{id:"highlight",label:null,title:"Highlight Marker"},{id:"line",label:null,title:"Line"},{id:"arrow",label:"↗",title:"Arrow"},{id:"polyline",label:null,title:"Polyline / Polygon"},{id:"circle",label:null,title:"Circle"},{id:"rect",label:null,title:"Rectangle"},{id:"cloud",label:null,title:"Revision Cloud"},{id:"dimension",label:null,title:"Dimension line"},{id:"text",label:"T",title:"Text"},{id:"callout",label:null,title:"Callout / Leader Note"},{id:"stamp",label:"⊞",title:"Stamp"}].map(t=>(
            <button key={t.id} onClick={()=>{setMarkupTool(t.id);if(t.id!=="select")setMarkupSelectedIdx(null);}} title={t.title} style={{width:32,height:32,borderRadius:7,border:markupTool===t.id?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:markupTool===t.id?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {t.id==="select"?<svg width="16" height="16" viewBox="0 0 20 20"><path d="M4 2 L4 15 L7.5 12 L10 17 L12 16 L9.5 11 L14 11 Z" fill="#fff" stroke="#fff" strokeWidth="0.8" strokeLinejoin="round"/></svg>
              :t.id==="highlight"?<svg width="16" height="16" viewBox="0 0 20 20"><rect x="2" y="7" width="16" height="6" rx="1" fill="#fff" opacity="0.5"/><line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.4"/></svg>
              :t.id==="polyline"?<svg width="16" height="16" viewBox="0 0 20 20"><polyline points="2,16 7,4 13,14 18,6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              :t.id==="circle"?<svg width="16" height="16" viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="8" ry="8" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
              :t.id==="rect"?<svg width="16" height="16" viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="12" fill="none" stroke="#fff" strokeWidth="1.5"/></svg>
              :t.id==="cloud"?<svg width="16" height="16" viewBox="0 0 20 20"><path d="M4,14 A3,3 0 0,1 4,8 A4,4 0 0,1 8,5 A4,4 0 0,1 14,5 A4,4 0 0,1 17,8 A3,3 0 0,1 17,14 Z" fill="none" stroke="#fff" strokeWidth="1.2"/></svg>
              :t.id==="line"?<svg width="16" height="16" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg>
              :t.id==="dimension"?<svg width="16" height="16" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="#fff" strokeWidth="1"/><line x1="3" y1="6" x2="3" y2="14" stroke="#fff" strokeWidth="1.5"/><line x1="17" y1="6" x2="17" y2="14" stroke="#fff" strokeWidth="1.5"/><text x="10" y="8" fill="#fff" fontSize="6" textAnchor="middle" fontFamily="sans-serif">d</text></svg>
              :t.id==="callout"?<svg width="16" height="16" viewBox="0 0 20 20"><line x1="3" y1="16" x2="10" y2="6" stroke="#fff" strokeWidth="1.2"/><rect x="9" y="2" width="9" height="7" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.2"/><text x="13.5" y="7.5" fill="#fff" fontSize="5" textAnchor="middle" fontFamily="sans-serif">A</text></svg>
              :t.label}
            </button>
          ))}
          <button onClick={()=>markupPhotoRef.current?.click()} title="Add photo — drag on drawing to place" style={{width:32,height:32,borderRadius:7,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>📷</button>
          <input ref={markupPhotoRef} type="file" accept="image/*" capture="environment" onChange={handleMarkupPhotoFile} style={{display:"none"}}/>
          <div style={{width:1,height:22,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
          {/* Color — consolidated swatch dropdown */}
          {(()=>{
            const COLORS=["#ff3b30","#ff9500","#ffcc00","#34c759","#fff"];
            return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(dvColorTimer.current);setShowDvColorMenu(true);}} onMouseLeave={()=>{dvColorTimer.current=setTimeout(()=>setShowDvColorMenu(false),250);}}>
              <button onClick={()=>setShowDvColorMenu(v=>!v)} title="Color" style={{width:32,height:32,borderRadius:7,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>
                <span style={{width:16,height:16,borderRadius:"50%",background:markupColor,border:"1.5px solid rgba(0,0,0,0.5)",boxShadow:"0 0 0 1px rgba(255,255,255,0.4) inset"}}/>
              </button>
              {showDvColorMenu&&<div onMouseEnter={()=>clearTimeout(dvColorTimer.current)} onMouseLeave={()=>{dvColorTimer.current=setTimeout(()=>setShowDvColorMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",display:"flex",gap:6}}>
                {COLORS.map(c=>(
                  <button key={c} onClick={()=>{setMarkupColor(c);if(markupSelectedIdx!=null)setMarkupStrokes(s=>s.map((st,i)=>i===markupSelectedIdx?{...st,color:c}:st));setShowDvColorMenu(false);}} style={{width:26,height:26,borderRadius:"50%",border:markupColor===c?"3px solid #fff":"2px solid rgba(255,255,255,0.2)",background:c,cursor:"pointer"}}/>
                ))}
              </div>}
            </div>;
          })()}
          {/* Line style toggle — solid / dotted */}
          <button onClick={()=>setMarkupLineStyle(s=>s==="solid"?"dotted":"solid")} title={markupLineStyle==="solid"?"Solid line (tap for dotted)":"Dotted line (tap for solid)"} style={{width:32,height:32,borderRadius:7,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="16" height="16" viewBox="0 0 20 20">
              {markupLineStyle==="solid"
                ?<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                :<line x1="2" y1="10" x2="18" y2="10" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3"/>}
            </svg>
          </button>
          {/* Text size — S/M/L/XL dropdown */}
          {(()=>{
            const SIZES=[{id:"S",v:1.8},{id:"M",v:2.4},{id:"L",v:3.4},{id:"XL",v:4.8}];
            const sel=markupStrokes[markupSelectedIdx];
            const activeSize=(sel&&sel.type==="text")?(sel.fontSize||2.4):markupTextSize;
            const activeLabel=SIZES.find(s=>Math.abs(activeSize-s.v)<0.01)?.id||"M";
            return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(dvSizeTimer.current);setShowDvSizeMenu(true);}} onMouseLeave={()=>{dvSizeTimer.current=setTimeout(()=>setShowDvSizeMenu(false),250);}}>
              <button onClick={()=>setShowDvSizeMenu(v=>!v)} title={`Text size ${activeLabel}`} style={{minWidth:32,height:32,padding:"0 7px",borderRadius:7,border:"2px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>{activeLabel}</button>
              {showDvSizeMenu&&<div onMouseEnter={()=>clearTimeout(dvSizeTimer.current)} onMouseLeave={()=>{dvSizeTimer.current=setTimeout(()=>setShowDvSizeMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",display:"flex",gap:4}}>
                {SIZES.map(sz=>{
                  const isActive=activeLabel===sz.id;
                  return <button key={sz.id} onClick={()=>{setMarkupTextSizeBoth(sz.v);setShowDvSizeMenu(false);}} style={{minWidth:28,height:28,padding:"0 6px",borderRadius:6,border:isActive?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:isActive?"rgba(88,86,214,0.25)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>{sz.id}</button>;
                })}
              </div>}
            </div>;
          })()}
          {/* Text alignment — 9-way grid */}
          {(()=>{
            const sel=markupStrokes[markupSelectedIdx];
            const curH=(sel&&sel.type==="text")?(sel.align||"left"):markupTextAlign;
            const curV=(sel&&sel.type==="text")?(sel.valign||"bottom"):markupTextValign;
            const HS=["left","center","right"],VS=["top","middle","bottom"];
            const hIdx=HS.indexOf(curH),vIdx=VS.indexOf(curV);
            return <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(dvAlignTimer.current);setShowDvAlignMenu(true);}} onMouseLeave={()=>{dvAlignTimer.current=setTimeout(()=>setShowDvAlignMenu(false),250);}}>
              <button onClick={()=>setShowDvAlignMenu(v=>!v)} title={`Text align: ${curV}-${curH}`} style={{width:36,height:36,borderRadius:8,border:"2px solid rgba(88,86,214,0.35)",background:"rgba(88,86,214,0.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>
                <svg width="14" height="14" viewBox="-0.1 -0.1 3.2 3.2">
                  {[0,1,2].map(r=>[0,1,2].map(c=>(
                    <rect key={`${r}-${c}`} x={c} y={r} width="0.9" height="0.9" fill={(r===vIdx&&c===hIdx)?"#5856d6":"rgba(255,255,255,0.25)"} stroke="rgba(0,0,0,0.4)" strokeWidth="0.05"/>
                  )))}
                </svg>
              </button>
              {showDvAlignMenu&&<div onMouseEnter={()=>clearTimeout(dvAlignTimer.current)} onMouseLeave={()=>{dvAlignTimer.current=setTimeout(()=>setShowDvAlignMenu(false),250);}} style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:8,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)"}}>
                <div style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.08em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6,whiteSpace:"nowrap"}}>TEXT ALIGNMENT</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,26px)",gap:3}}>
                  {VS.map(v=>HS.map(h=>{
                    const isActive=curH===h&&curV===v;
                    return <button key={`${v}-${h}`} onClick={()=>{setMarkupTextAnchor(v,h);setShowDvAlignMenu(false);}} title={`${v}-${h}`} style={{width:26,height:26,borderRadius:4,border:isActive?"1.5px solid #5856d6":"1.5px solid rgba(255,255,255,0.15)",background:isActive?"rgba(88,86,214,0.25)":"rgba(255,255,255,0.05)",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <svg width="14" height="14" viewBox="-0.1 -0.1 3.2 3.2">
                        {[0,1,2].map(r=>[0,1,2].map(c=>(
                          <rect key={`${r}-${c}`} x={c} y={r} width="0.9" height="0.9" fill={(VS[r]===v&&HS[c]===h)?"#5856d6":"rgba(255,255,255,0.2)"} stroke="rgba(0,0,0,0.4)" strokeWidth="0.05"/>
                        )))}
                      </svg>
                    </button>;
                  }))}
                </div>
              </div>}
            </div>;
          })()}
          {/* Stamp picker */}
          {markupTool==="stamp"&&(
            <div style={{position:"relative"}}>
              <button onClick={()=>setShowDvStampMenu(v=>!v)} style={{height:28,padding:"0 8px",borderRadius:6,border:"2px solid rgba(88,86,214,0.4)",background:"rgba(88,86,214,0.15)",color:"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{dvStampType}</button>
              {showDvStampMenu&&<div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:6,zIndex:100,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",maxHeight:200,overflowY:"auto",minWidth:140}}>
                {DV_STAMP_PRESETS.map(st=>(
                  <button key={st} onClick={()=>{setDvStampType(st);setShowDvStampMenu(false);}} style={{display:"block",width:"100%",padding:"5px 8px",border:"none",borderRadius:4,background:dvStampType===st?"rgba(88,86,214,0.25)":"none",color:st==="APPROVED"?"#34c759":st==="REJECTED"?"#ff3b30":st==="REVIEWED"?"#007aff":"#d8d2ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:10,cursor:"pointer",textAlign:"left",marginBottom:2}}>{st}</button>
                ))}
              </div>}
            </div>
          )}
          {/* Polyline controls */}
          {markupTool==="polyline"&&dvPolylinePoints.length>0&&(
            <>
              <button onClick={()=>setDvPolylineClosed(v=>!v)} style={{height:28,padding:"0 8px",borderRadius:6,border:dvPolylineClosed?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:dvPolylineClosed?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,cursor:"pointer"}}>{dvPolylineClosed?"POLYGON":"OPEN"}</button>
              <button onClick={finishDvPolyline} style={{height:28,padding:"0 10px",borderRadius:6,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>DONE ({dvPolylinePoints.length}pts)</button>
            </>
          )}
          <div style={{flex:1}}/>
          {markupSelectedIdx!=null&&markupTool==="select"&&markupStrokes[markupSelectedIdx]?.type==="photo"&&(
            <>
              <button onClick={()=>scaleSelectedPhoto(0.85)} title="Scale down" style={{background:"rgba(88,86,214,0.22)",border:"1px solid rgba(88,86,214,0.4)",borderRadius:8,width:30,height:28,color:"#c9c7ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
              <button onClick={()=>scaleSelectedPhoto(1.18)} title="Scale up" style={{background:"rgba(88,86,214,0.22)",border:"1px solid rgba(88,86,214,0.4)",borderRadius:8,width:30,height:28,color:"#c9c7ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
            </>
          )}
          {markupSelectedIdx!=null&&markupTool==="select"&&(
            <button onClick={deleteSelectedMarkup} style={{background:"rgba(255,59,48,0.25)",border:"1px solid rgba(255,59,48,0.45)",borderRadius:8,padding:"6px 10px",color:"#ff8f8f",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>{t("actions.delete")}</button>
          )}
          <button onClick={undoMarkup} disabled={!markupStrokes.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:markupStrokes.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.undo")}</button>
          <button onClick={redoMarkup} disabled={!markupRedoStack.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:markupRedoStack.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.redo")}</button>
          <button onClick={clearMarkup} disabled={!markupStrokes.length} style={{background:"rgba(255,59,48,0.2)",border:"none",borderRadius:8,padding:"6px 10px",color:markupStrokes.length?"#ff6b6b":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>CLEAR</button>
        </div>
      )}

      {/* Pending photo placement banner */}
      {markupMode&&pendingPhoto&&(
        <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:10,background:"rgba(88,86,214,0.18)",borderBottom:"1px solid rgba(88,86,214,0.35)",flexShrink:0}}>
          <span style={{fontSize:14}}>📷</span>
          <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:"#fff"}}>Drag on the drawing to place the photo · tap to drop at default size</div>
          <button onClick={cancelPendingPhoto} style={{background:"rgba(255,255,255,0.12)",border:"none",borderRadius:8,padding:"5px 10px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t("actions.cancel")}</button>
        </div>
      )}

      {/* Drawing canvas */}
      <div ref={containerRef} style={{flex:1,overflow:"hidden",position:"relative",cursor:markupMode?"crosshair":placing&&!viewMode?"crosshair":"grab",touchAction:"none"}}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {/* ADD PIN visible banner — pointer-events none so it doesn't eat taps */}
        {placing&&!viewMode&&(
          <div style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",background:"rgba(255,107,0,0.95)",color:"#fff",padding:"8px 16px",borderRadius:22,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,boxShadow:"0 4px 14px rgba(0,0,0,0.4)",zIndex:20,pointerEvents:"none",whiteSpace:"nowrap"}}>📍 Tap the drawing to drop a pin</div>
        )}
        {/* Zoom controls — inside the canvas so they never overlap toolbars */}
        <div style={{position:"absolute",right:10,top:10,zIndex:10,display:"flex",flexDirection:"column",gap:5,pointerEvents:"auto"}} onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}>
          <button onClick={zoomIn} style={{width:34,height:34,borderRadius:10,background:"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>+</button>
          <button onClick={resetZoom} style={{width:34,height:34,borderRadius:10,background:"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:10,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>{Math.round(scale*100)}%</button>
          <button onClick={zoomOut} style={{width:34,height:34,borderRadius:10,background:"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>−</button>
          {pagePins.length>0&&<button onClick={()=>setShowHeatmap(!showHeatmap)} style={{width:34,height:34,borderRadius:10,background:showHeatmap?"rgba(255,59,48,0.6)":"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",marginTop:4,boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}} title="Heatmap">🔥</button>}
        </div>
        {/* PDF page navigation — also inside the canvas */}
        {isPdf&&pdfPageCount>1&&(
          <div style={{position:"absolute",left:10,top:10,zIndex:10,display:"flex",flexDirection:"column",gap:5,pointerEvents:"auto"}} onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}>
            <button onClick={prevPage} disabled={currentPage<=1} style={{width:34,height:34,borderRadius:10,background:currentPage<=1?"rgba(0,0,0,0.3)":"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:16,cursor:currentPage<=1?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>▲</button>
            <div style={{width:34,height:34,borderRadius:10,background:"rgba(0,0,0,0.62)",color:"#fff",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>{currentPage}</div>
            <button onClick={nextPage} disabled={currentPage>=pdfPageCount} style={{width:34,height:34,borderRadius:10,background:currentPage>=pdfPageCount?"rgba(0,0,0,0.3)":"rgba(0,0,0,0.62)",border:"none",color:"#fff",fontSize:16,cursor:currentPage>=pdfPageCount?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 6px rgba(0,0,0,0.35)"}}>▼</button>
          </div>
        )}
        {isImage?(
          <div style={{position:"relative",transform:`scale(${scale}) translate(${offset.x/scale}px,${offset.y/scale}px)`,transformOrigin:"0 0",transition:dragRef.current?"none":"transform 0.15s ease",maxWidth:"100%",margin:"0 auto"}}>
            <img ref={imgRef} src={fileUrl} alt={drawing.name} onClick={markupMode?undefined:handleDrawingClick}
              style={{maxWidth:"100%",maxHeight:"calc(100vh - 120px)",objectFit:"contain",display:"block",margin:"0 auto",userSelect:"none",pointerEvents:markupMode?"none":"auto"}}
              draggable={false}/>
            {/* Markup SVG overlay */}
            <svg ref={markupSvgRef} viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:markupMode?"auto":"none",touchAction:"none"}}
              onMouseDown={onMarkupDown} onMouseMove={onMarkupMove} onMouseUp={onMarkupUp} onMouseLeave={onMarkupUp}
              onTouchStart={onMarkupDown} onTouchMove={onMarkupMove} onTouchEnd={onMarkupUp}>
              {renderMarkupSvg(markupStrokes)}
              {markupCurrent&&renderMarkupSvg([markupCurrent])}
              {dvPolylinePoints.length>1&&<polyline points={dvPolylinePoints.map(p=>`${p.x},${p.y}`).join(" ")} stroke={markupColor} strokeWidth="0.3" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.8 0.4"/>}
              {dvPolylinePoints.length===1&&<circle cx={dvPolylinePoints[0].x} cy={dvPolylinePoints[0].y} r="0.5" fill={markupColor}/>}
              {pendingPhoto&&photoPlaceRect&&photoPlaceRect.w>0&&(
                <g>
                  <image href={pendingPhoto.dataUrl} x={photoPlaceRect.x} y={photoPlaceRect.y} width={photoPlaceRect.w} height={photoPlaceRect.w*pendingPhoto.aspect} preserveAspectRatio="xMidYMid meet" opacity="0.7"/>
                  <rect x={photoPlaceRect.x} y={photoPlaceRect.y} width={photoPlaceRect.w} height={photoPlaceRect.w*pendingPhoto.aspect} fill="none" stroke="#5856d6" strokeWidth="0.4" strokeDasharray="1 0.6"/>
                </g>
              )}
            </svg>
            {renderHeatmap()}
            {renderNotes()}
            {!markupMode&&renderPins()}
          </div>
        ):isPdf?(
          <div style={{position:"relative",transform:`scale(${scale}) translate(${offset.x/scale}px,${offset.y/scale}px)`,transformOrigin:"0 0",transition:dragRef.current?"none":"transform 0.15s ease"}}>
            {pdfLoading&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh",color:"rgba(255,255,255,0.4)"}}><Spin size={20}/><span style={{marginLeft:10,fontSize:13}}>Loading PDF...</span></div>}
            {pdfError&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh",color:"#ff6b6b",fontSize:13}}>{pdfError}</div>}
            {!pdfLoading&&!pdfError&&<canvas ref={canvasRef} onClick={markupMode?undefined:handleDrawingClick} style={{maxWidth:"100%",maxHeight:"calc(100vh - 120px)",objectFit:"contain",display:"block",margin:"0 auto",userSelect:"none",pointerEvents:markupMode?"none":"auto"}}/>}
            {/* Markup SVG overlay for PDF */}
            {!pdfLoading&&!pdfError&&(
              <svg ref={markupSvgRef} viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:markupMode?"auto":"none",touchAction:"none"}}
                onMouseDown={onMarkupDown} onMouseMove={onMarkupMove} onMouseUp={onMarkupUp} onMouseLeave={onMarkupUp}
                onTouchStart={onMarkupDown} onTouchMove={onMarkupMove} onTouchEnd={onMarkupUp}>
                {renderMarkupSvg(markupStrokes)}
                {markupCurrent&&renderMarkupSvg([markupCurrent])}
                {dvPolylinePoints.length>1&&<polyline points={dvPolylinePoints.map(p=>`${p.x},${p.y}`).join(" ")} stroke={markupColor} strokeWidth="0.3" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.8 0.4"/>}
                {dvPolylinePoints.length===1&&<circle cx={dvPolylinePoints[0].x} cy={dvPolylinePoints[0].y} r="0.5" fill={markupColor}/>}
              </svg>
            )}
            {!pdfLoading&&!pdfError&&renderHeatmap()}
            {!pdfLoading&&!pdfError&&renderNotes()}
            {!markupMode&&!pdfLoading&&!pdfError&&renderPins()}
          </div>
        ):(
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"rgba(255,255,255,0.4)"}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:48,marginBottom:12}}>📄</div>
              <div style={{fontSize:14}}>Unsupported file type</div>
              <a href={fileUrl} target="_blank" rel="noopener" style={{color:"#ff6b00",fontSize:13,marginTop:8,display:"inline-block"}}>Download file ↗</a>
            </div>
          </div>
        )}
      </div>

      {/* Combined list: pins + defects + text notes */}
      {showCombinedList&&(
        <div style={{position:"absolute",left:0,right:0,bottom:0,zIndex:40,background:"linear-gradient(to top, rgba(0,0,0,0.95), rgba(0,0,0,0.88))",borderTop:"1px solid rgba(255,255,255,0.12)",maxHeight:"42vh",display:"flex",flexDirection:"column"}}>
          <div style={{padding:"9px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)",gap:6}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff",flex:1}}>CONSOLIDATED LIST · {combinedItems.length}</div>
            <button onClick={exportDrawingCsv} disabled={!combinedItems.length} style={{background:"rgba(52,170,220,0.2)",border:"1px solid rgba(52,170,220,0.4)",borderRadius:6,padding:"4px 8px",color:"#7fd7ff",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>CSV</button>
            <button onClick={exportDrawingPdf} disabled={!combinedItems.length} style={{background:"rgba(255,107,0,0.2)",border:"1px solid rgba(255,107,0,0.4)",borderRadius:6,padding:"4px 8px",color:"#ffb48a",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>PDF</button>
          </div>
          <div style={{overflowY:"auto",padding:10}}>
            {combinedItems.length===0&&<div style={{padding:12,textAlign:"center",color:"rgba(255,255,255,0.45)",fontSize:12}}>No pins or notes on this view.</div>}
            {combinedItems.map(item=>(
              <div key={item.kind+"_"+item.id} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 10px",marginBottom:7,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12}}>{item.kind==="note"?"📝":item.kind==="markup"?"✏":"📌"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:"#fff",fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.title}</div>
                  <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    {item.kind==="note"?`By ${item.detail||"Unknown"} · (${Math.round(item.x)}%, ${Math.round(item.y)}%)`:item.kind==="markup"?`${item.status} · ${item.detail}`:`${item.severity} · ${item.status}${item.detail?` · ${item.detail}`:""}`}
                  </div>
                </div>
                {item.kind==="pin"&&canPin&&<button onClick={()=>deletePin(item.id)} style={{background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:7,padding:"4px 8px",color:"#ff8f8f",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>REMOVE</button>}
                {item.kind==="note"&&canPin&&<button onClick={()=>deleteNote(item.id)} style={{background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:7,padding:"4px 8px",color:"#ff8f8f",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("actions.delete")}</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Text note modal for note tool (pin-based notes) */}
      {pendingNotePos&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.84)",zIndex:320,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:360,background:"#1a1a1a",borderRadius:16,padding:18,border:"1px solid rgba(255,255,255,0.12)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",marginBottom:6}}>ADD DRAWING NOTE</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Type or dictate a note. This appears in the consolidated list with pins and defects.</div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input autoFocus value={noteText} onChange={e=>setNoteText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addNote()} placeholder={t("fields.note_placeholder")} style={{flex:1,padding:"12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:13,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
              <MicBtn onResult={t=>setNoteText(v=>v?(v+" "+t):t)} append currentValue={noteText}/>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setPendingNotePos(null);setNoteText("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
              <button onClick={addNote} disabled={!noteText.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:noteText.trim()?"#5856d6":"rgba(255,255,255,0.1)",color:noteText.trim()?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD NOTE</button>
            </div>
          </div>
        </div>
      )}

      {/* Markup text input modal (text tool — with font size) */}
      {pendingTextPos&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.84)",zIndex:320,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:360,background:"#1a1a1a",borderRadius:16,padding:18,border:"1px solid rgba(255,255,255,0.12)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",marginBottom:6}}>ADD TEXT ANNOTATION</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Text appears directly on the drawing at the tapped location.</div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
              <input autoFocus value={pendingTextValue} onChange={e=>setPendingTextValue(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submitMarkupText()} placeholder={t("markup.type_text")} style={{flex:1,padding:"12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:13,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
              <MicBtn onResult={t=>setPendingTextValue(v=>v?(v+" "+t):t)} append currentValue={pendingTextValue}/>
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:10,color:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>SIZE</span>
              {[{id:"S",v:1.8},{id:"M",v:2.4},{id:"L",v:3.4},{id:"XL",v:4.8}].map(sz=>(
                <button key={sz.id} onClick={()=>setMarkupTextSize(sz.v)} style={{minWidth:28,height:28,padding:"0 6px",borderRadius:6,border:Math.abs(markupTextSize-sz.v)<0.01?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:Math.abs(markupTextSize-sz.v)<0.01?"rgba(88,86,214,0.25)":"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,cursor:"pointer"}}>{sz.id}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setPendingTextPos(null);setPendingTextValue("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
              <button onClick={submitMarkupText} disabled={!pendingTextValue.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:pendingTextValue.trim()?"#ff6b00":"rgba(255,255,255,0.1)",color:pendingTextValue.trim()?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD TEXT</button>
            </div>
          </div>
        </div>
      )}

      {/* Dimension label input */}
      {pendingDimStroke&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.84)",zIndex:320,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:340,background:"#1a1a1a",borderRadius:16,padding:18,border:"1px solid rgba(255,255,255,0.12)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",marginBottom:6}}>DIMENSION LABEL</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Enter the measurement (e.g. 3.5m, 1200mm, 4'-6"). Leave blank for no label.</div>
            <input autoFocus value={dimLabel} onChange={e=>setDimLabel(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){addMarkupStroke({...pendingDimStroke,label:dimLabel.trim()});setPendingDimStroke(null);setDimLabel("");}}} placeholder="e.g. 3500mm" style={{width:"100%",padding:"12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setPendingDimStroke(null);setDimLabel("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t("actions.cancel")}</button>
              <button onClick={()=>{addMarkupStroke({...pendingDimStroke,label:dimLabel.trim()});setPendingDimStroke(null);setDimLabel("");}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
            </div>
          </div>
        </div>
      )}

      {/* Callout text modal */}
      {dvCalloutStroke&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.84)",zIndex:320,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:340,background:"#1a1a1a",borderRadius:16,padding:18,border:"1px solid rgba(255,255,255,0.12)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",marginBottom:6}}>CALLOUT LABEL</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Enter the callout text. Leave blank for arrow only.</div>
            <input autoFocus value={dvCalloutText} onChange={e=>setDvCalloutText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){addMarkupStroke({...dvCalloutStroke,text:dvCalloutText.trim(),fontSize:markupTextSize});setDvCalloutStroke(null);setDvCalloutText("");}}} placeholder="e.g. Check alignment" style={{width:"100%",padding:"12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{addMarkupStroke({...dvCalloutStroke,text:""});setDvCalloutStroke(null);setDvCalloutText("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>SKIP</button>
              <button onClick={()=>{addMarkupStroke({...dvCalloutStroke,text:dvCalloutText.trim(),fontSize:markupTextSize});setDvCalloutStroke(null);setDvCalloutText("");}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#5856d6",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
            </div>
          </div>
        </div>
      )}

      {/* Entry picker modal */}
      {linkEntry&&!quickCreate&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:20,width:"100%",maxWidth:400,maxHeight:"70vh",overflowY:"auto"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff",marginBottom:4}}>LINK TO ENTRY</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:16}}>Select an existing entry or create new</div>
            {/* Quick-create button */}
            {onSaveEntry&&(
              <button onClick={()=>setQuickCreate(true)} style={{width:"100%",background:"rgba(255,107,0,0.15)",border:"2px dashed rgba(255,107,0,0.4)",borderRadius:10,padding:"12px 14px",marginBottom:12,cursor:"pointer",textAlign:"center",color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13}}>+ CREATE NEW ENTRY & PIN HERE</button>
            )}
            {defects.length===0&&!onSaveEntry&&<div style={{color:"rgba(255,255,255,0.3)",textAlign:"center",padding:20}}>No entries to link</div>}
            {defects.map(d=>(
              <button key={d.id} onClick={()=>savePin(d.id)} style={{width:"100%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"10px 14px",marginBottom:8,cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderLeft:`4px solid ${SEV_COLOR[d.severity]}`}}>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#fff"}}>{d.title}</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>{d.severity} · {d.status} · {d.location}</div>
                </div>
              </button>
            ))}
            <button onClick={()=>setLinkEntry(null)} style={{width:"100%",background:"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:12,color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",marginTop:4}}>{t("actions.cancel")}</button>
          </div>
        </div>
      )}

      {/* Quick-create entry form */}
      {linkEntry&&quickCreate&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:20,width:"100%",maxWidth:400,maxHeight:"80vh",overflowY:"auto"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff",marginBottom:4}}>QUICK LOG ENTRY</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:16}}>Create entry and pin it to this location</div>
            <input type="file" accept="image/*" capture="environment" ref={qPhotoRef} onChange={e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=()=>setQPhoto(r.result);r.readAsDataURL(f);}} style={{display:"none"}}/>
            {/* Photo */}
            {qPhoto?(
              <div style={{position:"relative",marginBottom:12}}>
                <img src={qPhoto} alt="" style={{width:"100%",maxHeight:150,objectFit:"contain",borderRadius:10,background:"rgba(255,255,255,0.05)"}}/>
                <button onClick={()=>setQPhoto(null)} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:24,height:24,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
              </div>
            ):(
              <button onClick={()=>qPhotoRef.current?.click()} style={{width:"100%",background:"rgba(255,255,255,0.05)",border:"2px dashed rgba(255,255,255,0.15)",borderRadius:10,padding:16,color:"rgba(255,255,255,0.4)",fontSize:13,cursor:"pointer",marginBottom:12}}>📷 Take photo</button>
            )}
            {/* Title */}
            <input value={qTitle} onChange={e=>setQTitle(e.target.value)} placeholder="Defect title..." style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",marginBottom:12,boxSizing:"border-box"}}/>
            {/* Severity */}
            <ComboField label={t("fields.severity")} value={qSev} onChange={v=>setQSev(v)} options={SEVERITY} placeholder={t("fields.severity_placeholder")} displayFn={sevDisplayFn}/>
            {/* Actions */}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setQuickCreate(false);setQTitle("");setQPhoto(null);}} style={{flex:1,padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
              <button disabled={!qTitle.trim()||qSaving} onClick={async()=>{
                setQSaving(true);
                try{
                  let photo=null;
                  if(qPhoto){photo=await compressPhoto(qPhoto);}
                  const entryData={title:qTitle,severity:qSev,status:"Open",entryType:"Defect",
                    location:drawing.name,description:t("drawings.pinned_on")+drawing.name,
                    photo:photo||null,extraPhotos:[],
                    projectId:currentProject?.id||"default",projectName:currentProject?.name||"",
                    loggedBy:member?.name||"",loggedByRole:member?.role||"",
                    createdAt:DB.serverTimestamp(),updatedAt:DB.serverTimestamp(),comments:[]};
                  const saved=await onSaveEntry(entryData);
                  // Use returned record ID directly — no fragile title lookup
                  const entryId=saved?.id||saved;
                  if(entryId&&entryId!=="queued"){
                    await DB.pins.create({drawingId:drawing.id,entryId,pageNum:linkEntry.pageNum||1,x:linkEntry.x,y:linkEntry.y,label:""});
                  }
                  setQuickCreate(false);setQTitle("");setQSev("Major");setQPhoto(null);setLinkEntry(null);
                }catch(e){alert("Failed: "+e.message);}
                setQSaving(false);
              }} style={{flex:1,padding:12,borderRadius:10,border:"none",background:qTitle.trim()?"#ff6b00":"rgba(255,255,255,0.1)",color:qTitle.trim()?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{qSaving?"SAVING...":"CREATE & PIN"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Admin Analytics Dashboard ─────────────────────────────────────
function AdminAnalytics({defects,members,company,currentProject,projects,allDefects}){
  const now=new Date();
  const todayStr=now.toISOString().slice(0,10);
  const weekAgo=new Date(now-7*86400000);
  const monthAgo=new Date(now-30*86400000);

  // Time-based counts
  const toDate=d=>d.createdAt||d.created||d.timestamp_utc||"";
  const today=defects.filter(d=>toDate(d).slice(0,10)===todayStr).length;
  const week=defects.filter(d=>new Date(toDate(d))>=weekAgo).length;
  const month=defects.filter(d=>new Date(toDate(d))>=monthAgo).length;

  // Per-user stats
  const userEntries={};
  defects.forEach(d=>{const u=d.loggedBy||"Unknown";userEntries[u]=(userEntries[u]||0)+1;});
  const userRanking=Object.entries(userEntries).sort((a,b)=>b[1]-a[1]);
  const activeUsers=userRanking.length;

  // Photos per entry
  const totalPhotos=defects.reduce((n,d)=>{
    if(Array.isArray(d.photo))return n+d.photo.length;
    if(d.photo)return n+1;
    if(d.gdrivePhotos){try{return n+JSON.parse(d.gdrivePhotos).length;}catch{}}
    return n;
  },0);
  const avgPhotos=defects.length>0?(totalPhotos/defects.length).toFixed(1):"0";

  // Entries by project (use allDefects if available for cross-project view)
  const projEntries={};
  (allDefects||defects).forEach(d=>{const p=d.projectName||"Unknown";projEntries[p]=(projEntries[p]||0)+1;});
  const projRanking=Object.entries(projEntries).sort((a,b)=>b[1]-a[1]);

  // AI usage
  const aiUsage=local.get(AI_LIMIT_KEY)||{date:"",count:0};
  const aiToday=aiUsage.date===todayStr?aiUsage.count:0;
  const aiProvider=local.get(AI_PROVIDER_KEY)||"gemini";
  const aiAnalyzed=defects.filter(d=>d.category||d.defect_type).length;

  // Entry types breakdown
  const typeEntries={};
  defects.forEach(d=>{const t=d.entryType||"Defect";typeEntries[t]=(typeEntries[t]||0)+1;});
  const typeRanking=Object.entries(typeEntries).sort((a,b)=>b[1]-a[1]);

  // Per-user detail (who submitted what today/week)
  const userToday={};const userWeek={};
  defects.forEach(d=>{
    const u=d.loggedBy||"Unknown";const dt=toDate(d);
    if(dt.slice(0,10)===todayStr){userToday[u]=(userToday[u]||0)+1;}
    if(new Date(dt)>=weekAgo){userWeek[u]=(userWeek[u]||0)+1;}
  });

  const StatCard=({label,value,sub,color})=>(
    <div style={{flex:1,minWidth:90,background:"#fff",borderRadius:12,padding:"14px 12px",borderTop:`3px solid ${color||"#ff6b00"}`}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#1a1a1a",lineHeight:1}}>{value}</div>
      <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.06em",fontFamily:"'Barlow Condensed',sans-serif",marginTop:4}}>{label}</div>
      {sub&&<div style={{fontSize:10,color:"rgba(0,0,0,0.3)",marginTop:2}}>{sub}</div>}
    </div>
  );

  const BarRow=({label,value,max,color})=>(
    <div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
        <span style={{fontSize:12,color:"#444",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>{label}</span>
        <span style={{fontSize:12,fontWeight:700,color:color||"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif"}}>{value}</span>
      </div>
      <div style={{background:"rgba(0,0,0,0.06)",borderRadius:4,height:6,overflow:"hidden"}}>
        <div style={{width:`${max>0?(value/max*100):0}%`,height:"100%",background:color||"#ff6b00",borderRadius:4,transition:"width 0.3s ease"}}/>
      </div>
    </div>
  );

  const maxUser=userRanking.length>0?userRanking[0][1]:1;
  const maxProj=projRanking.length>0?projRanking[0][1]:1;

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>{t("dashboard.admin_analytics")}</div>
        <div style={{fontSize:10,fontWeight:700,color:"#ff3b30",background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>ADMIN ONLY</div>
      </div>
      <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginBottom:20}}>📁 {currentProject?.name||"All"} · {company?.companyName}</div>

      {/* Entries logged today/week/month */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>ENTRIES LOGGED</div>
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <StatCard label={t("dashboard.today")} value={today} color="#30d158"/>
        <StatCard label={t("dashboard.this_week")} value={week} color="#34aadc"/>
        <StatCard label={t("dashboard.this_month")} value={month} color="#ff9500"/>
        <StatCard label={t("dashboard.all_time")} value={defects.length} color="#8e8e93"/>
      </div>

      {/* Active users */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>ACTIVE USERS & SUBMISSIONS</div>
      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{display:"flex",gap:16,marginBottom:14}}>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:"#1a1a1a"}}>{activeUsers}</div><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif"}}>USERS</div></div>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:"#1a1a1a"}}>{members.length}</div><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif"}}>TEAM SIZE</div></div>
        </div>
        {/* Who submitted today */}
        {Object.keys(userToday).length>0&&(
          <div style={{marginBottom:12}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.35)",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>SUBMITTED TODAY</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {Object.entries(userToday).map(([u,c])=>(
                <span key={u} style={{fontSize:11,background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:20,padding:"3px 10px",color:"#1a7a35",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>{u} ({c})</span>
              ))}
            </div>
          </div>
        )}
        {/* Who submitted this week */}
        {Object.keys(userWeek).length>0&&(
          <div>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.35)",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:6}}>SUBMITTED THIS WEEK</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {Object.entries(userWeek).map(([u,c])=>(
                <span key={u} style={{fontSize:11,background:"rgba(52,170,220,0.1)",border:"1px solid rgba(52,170,220,0.2)",borderRadius:20,padding:"3px 10px",color:"#1a6a8a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>{u} ({c})</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Entries per user ranking */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>ENTRIES PER USER (ALL TIME)</div>
      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
        {userRanking.length===0&&<div style={{color:"rgba(0,0,0,0.3)",fontSize:13,textAlign:"center",padding:"10px 0"}}>No entries yet</div>}
        {userRanking.map(([name,count],i)=>(
          <BarRow key={name} label={`${i+1}. ${name}`} value={count} max={maxUser} color={i===0?"#ff6b00":i===1?"#ff9500":i===2?"#34aadc":"#8e8e93"}/>
        ))}
      </div>

      {/* Photos per entry */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>PHOTOS</div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <StatCard label={t("dashboard.total_photos")} value={totalPhotos} color="#5856d6"/>
        <StatCard label={t("dashboard.avg_per_entry")} value={avgPhotos} color="#e91e63"/>
      </div>

      {/* Entry types breakdown */}
      {typeRanking.length>1&&(
        <>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>BY ENTRY TYPE</div>
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            {typeRanking.map(([t,count])=>(
              <BarRow key={t} label={`${typeIcon(t)} ${t}`} value={count} max={typeRanking[0][1]} color={typeColor(t)}/>
            ))}
          </div>
        </>
      )}

      {/* Entries by project */}
      {projRanking.length>1&&(
        <>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>BY PROJECT</div>
          <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
            {projRanking.map(([p,count])=>(
              <BarRow key={p} label={`📁 ${p}`} value={count} max={maxProj} color="#ff6b00"/>
            ))}
          </div>
        </>
      )}

      {/* AI usage */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>AI USAGE</div>
      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{display:"flex",gap:16,marginBottom:10}}>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:"#5856d6"}}>{aiToday}</div><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif"}}>TODAY / {AI_DAILY_LIMIT}</div></div>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:"#1a1a1a"}}>{aiAnalyzed}</div><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif"}}>AI-ANALYZED</div></div>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:"#1a1a1a"}}>{defects.length>0?Math.round(aiAnalyzed/defects.length*100):0}%</div><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif"}}>COVERAGE</div></div>
        </div>
        <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>Provider: <span style={{fontWeight:700,color:"#5856d6",textTransform:"uppercase"}}>{aiProvider}</span> · Daily limit: {AI_DAILY_LIMIT}</div>
        {/* Usage bar */}
        <div style={{marginTop:8,background:"rgba(0,0,0,0.06)",borderRadius:4,height:8,overflow:"hidden"}}>
          <div style={{width:`${Math.min(aiToday/AI_DAILY_LIMIT*100,100)}%`,height:"100%",background:aiToday>=AI_DAILY_LIMIT?"#ff3b30":"#5856d6",borderRadius:4}}/>
        </div>
      </div>
    </div>
  );
}

// ── App Root ──────────────────────────────────────────────────────
const NAV=[{id:"dashboard",icon:"⊞",labelKey:"nav.dashboard"},{id:"log",icon:"+",labelKey:"nav.log"},{id:"drawings",icon:"📐",labelKey:"nav.tag"},{id:"defects",icon:"≡",labelKey:"nav.review"},{id:"report",icon:"◎",labelKey:"nav.report"}];

// Dropdown line icons — stroke-only, single color
const DdIcon=({name,size=16})=>{
  const p={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round",strokeLinejoin:"round"};
  switch(name){
    case"folder":return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>;
    case"users":return <svg {...p}><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.3c2.8.3 5 2.3 5 4.7"/></svg>;
    case"ai":return <svg {...p}><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/></svg>;
    case"plane":return <svg {...p}><path d="M21 3L3 10l7 3 3 7 8-17z"/><path d="M10 13l4-4"/></svg>;
    case"disk":return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v6h8V4M9 15h6"/></svg>;
    case"user":return <svg {...p}><circle cx="12" cy="8" r="3.5"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>;
    case"chart":return <svg {...p}><path d="M4 20h16"/><rect x="6" y="11" width="3" height="8"/><rect x="11" y="6" width="3" height="13"/><rect x="16" y="13" width="3" height="6"/></svg>;
    case"help":return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5c.5-1.5 1.5-2 2.5-2 1.5 0 2.5 1 2.5 2.3 0 1.2-.8 1.7-1.5 2.2-.8.5-1 1-1 2"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>;
    case"chat":return <svg {...p}><path d="M4 5h16v10H8l-4 4V5z"/></svg>;
    case"logout":return <svg {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/></svg>;
    case"globe":return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3c2.2 2.5 3.5 5.5 3.5 9s-1.3 6.5-3.5 9c-2.2-2.5-3.5-5.5-3.5-9s1.3-6.5 3.5-9z"/></svg>;
    case"refresh":return <svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>;
    case"pin":return <svg {...p}><path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>;
    case"blueprint":return <svg {...p}><path d="M4 20L20 4"/><path d="M4 20h13"/><path d="M4 20V7"/></svg>;
    default:return null;
  }
};


function App(){
  const[lang,setLangState]=useState(_currentCode);
  // Re-render on language change
  useEffect(()=>{
    const unsub=onLangChange(code=>setLangState(code));
    return unsub;
  },[]);
  const setLang=loadLanguage;
  const languages=LANGUAGES;
  const[authUser,setAuthUser]=useState(null);
  const[authLoading,setAuthLoading]=useState(true);
  const[memberLoading,setMemberLoading]=useState(false);
  const[inviteCode,setInviteCode]=useState("");
  const[showLangPicker,setShowLangPicker]=useState(false);
  const[company,setCompany]=useState(()=>local.get(COMPANY_KEY));
  const[member,setMember]=useState(null);
  const[members,setMembers]=useState([]);
  const[projects,setProjects]=useState([]);
  const[currentProject,setCurrentProject]=useState(()=>local.get(PROJECT_KEY));
  const[defects,setDefects]=useState([]);
  const[syncing,setSyncing]=useState(true);
  const[tab,setTab]=useState("dashboard");
  const[viewing,setViewing]=useState(null);
  const[showTg,setShowTg]=useState(false);
  const[showEmail,setShowEmail]=useState(false);
  const[showGemini,setShowGemini]=useState(false);
  const[showUsers,setShowUsers]=useState(false);
  const[showProjects,setShowProjects]=useState(false);
  const[showProfile,setShowProfile]=useState(false);
  const[showHelp,setShowHelp]=useState(false);const[helpTab,setHelpTab]=useState("help");
  const[showFeedback,setShowFeedback]=useState(false);
  const[showStorage,setShowStorage]=useState(false);
  const[showMaps,setShowMaps]=useState(false);
  const[showAdminAnalytics,setShowAdminAnalytics]=useState(false);
  const[showSettingsMenu,setShowSettingsMenu]=useState(false);const settingsMenuTimer=useRef(null);
  // Close settings dropdown on outside click/touch (mouseleave alone doesn't
  // fire on touchscreens, so it would stay open and cover the content area).
  useEffect(()=>{
    if(!showSettingsMenu)return;
    const onAway=(e)=>{
      if(e.target.closest&&e.target.closest(".dd-panel"))return;
      if(e.target.closest&&e.target.closest('button[title="Settings"]'))return;
      setShowSettingsMenu(false);
    };
    document.addEventListener("pointerdown",onAway,true);
    return()=>document.removeEventListener("pointerdown",onAway,true);
  },[showSettingsMenu]);
  const[showAvatarMenu,setShowAvatarMenu]=useState(false);const avatarMenuTimer=useRef(null);
  const[showAiSearch,setShowAiSearch]=useState(false);
  const[nlFilters,setNlFilters]=useState(null);
  const[queueCount,setQueueCount]=useState(0);
  const[syncing2,setSyncing2]=useState(false);
  const[fbText,setFbText]=useState("");const[fbType,setFbType]=useState("suggestion");const[fbSent,setFbSent]=useState(false);const[fbSending,setFbSending]=useState(false);

  // Auth listener — also auto-recover company if localStorage was cleared
  useEffect(()=>{
    const inv=new URLSearchParams(window.location.search).get("invite")||"";
    setInviteCode(inv);
    // Init PocketBase — must complete before auth callbacks fire
    let unsub;
    DB.init(typeof PB_URL!=='undefined'?PB_URL:'https://api.siteshrimp.org').then(()=>{
      unsub=DB.auth.onAuthStateChanged(async u=>{
        setAuthUser(u);
        setAuthLoading(false); // unblock UI immediately; company recovery runs in background
        if(u){
          // Always try to recover company if not in state
          const saved=local.get(COMPANY_KEY);
          if(saved){setCompany(saved);setCurrentProject(local.get(PROJECT_KEY));}
          else{
            // Retry up to 3 times with increasing delay
            for(let attempt=0;attempt<3;attempt++){
              try{
                const result=await DB.findUserCompany(u.id);
                if(result){
                  const cd={companyId:result.companyId,companyName:result.companyName};
                  local.set(COMPANY_KEY,cd);
                  setCompany(cd);
                  const projs=await DB.projects.list(`companyId="${result.companyId}" && archived!=true`);
                  if(projs.length){
                    const proj={id:projs[0].id,name:projs[0].name};
                    local.set(PROJECT_KEY,proj);
                    setCurrentProject(proj);
                  }
                  try{await loadSettingsFromFirestore(result.companyId);}catch{}
                  break;
                }else{break;} // User genuinely has no company
              }catch(e){
                console.warn(`Company recovery attempt ${attempt+1} failed:`,e);
                if(attempt<2)await new Promise(r=>setTimeout(r,(attempt+1)*2000));
              }
            }
          }
        }
      });
    });
    return ()=>{if(unsub)unsub();};
  },[]);

  // Member + all members listener (with retry if member not found yet)
  useEffect(()=>{
    if(!authUser||!company?.companyId)return;
    setMemberLoading(true);
    let retryCount=0;
    let retryTimer=null;
    const unsub=DB.members.subscribe(`companyId="${company.companyId}"`,items=>{
      const me=items.find(m=>m.userId===authUser.id);
      if(me){
        retryCount=0;
        setMember({uid:me.userId,...me});
        setMemberLoading(false);
      }else if(retryCount<5){
        // Member record may not be available yet — retry
        retryCount++;
        console.warn(`Member not found (attempt ${retryCount}/5), retrying...`);
        retryTimer=setTimeout(()=>{
          DB.members.list(`companyId="${company.companyId}"`).then(fresh=>{
            const me2=fresh.find(m=>m.userId===authUser.id);
            if(me2){setMember({uid:me2.userId,...me2});setMemberLoading(false);}
          }).catch(()=>{});
        },retryCount*1500);
      }else{
        console.error("Member record not found after 5 retries");
        setMember(null);
        setMemberLoading(false);
      }
      setMembers(items.map(m=>({uid:m.userId,...m})));
    });
    return ()=>{if(retryTimer)clearTimeout(retryTimer);unsub();};
  },[authUser?.id,company?.companyId]);

  // Projects listener
  useEffect(()=>{
    if(!company?.companyId)return;
    return DB.projects.subscribe(`companyId="${company.companyId}" && archived!=true`,items=>{
      setProjects(items);
      if(!currentProject&&items.length>0){setCurrentProject(items[0]);local.set(PROJECT_KEY,items[0]);}
    });
  },[company?.companyId]);

  // Defects listener
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    setSyncing(true);
    return DB.defects.subscribe(`companyId="${company.companyId}" && projectId="${currentProject.id}"`,items=>{
      // Map photo filenames to URLs (supports PocketBase files, GDrive URLs, or local)
      const withPhotos=items.map(d=>{
        // Google Drive storage — photos stored as JSON array of URLs
        if(d.storageMode==="gdrive"&&d.gdrivePhotos){
          let gPhotos=[];
          try{gPhotos=JSON.parse(d.gdrivePhotos);}catch{}
          return{...d,photo:gPhotos.length>0?gPhotos:null};
        }
        // Default PocketBase storage — map filenames to URLs
        let photo=d.photo;
        if(Array.isArray(photo)&&photo.length>0){
          photo=photo.map(f=>DB.fileUrl("defects",d.id,f));
        }else if(typeof photo==="string"&&photo){
          photo=DB.fileUrl("defects",d.id,photo);
        }
        return{...d,photo};
      });
      setDefects(withPhotos);
      setSyncing(false);
    });
  },[company?.companyId,currentProject?.id]);

  const handleAuth=(user,name,inv)=>{setAuthUser(user);if(inv)setInviteCode(inv);};

  // Called when register + company setup completes in one step
  const handleFullSetup=(user,cd,proj)=>{
    setAuthUser(user);
    local.set(COMPANY_KEY,cd);setCompany(cd);
    if(proj){local.set(PROJECT_KEY,proj);setCurrentProject(proj);}
  };

  const handleCompanyDone=(cd,proj)=>{
    local.set(COMPANY_KEY,cd);
    setCompany(cd);
    if(proj){setCurrentProject(proj);local.set(PROJECT_KEY,proj);}
  };

  const selectProject=proj=>{
    setCurrentProject(proj);local.set(PROJECT_KEY,proj);
  };

  // ── Upload a single defect entry (online) ──
  const uploadDefect=async(data,companyId)=>{
    const storageCfg=local.get(STORAGE_KEY)||{mode:"pocketbase"};
    if(storageCfg.mode==="gdrive"&&GDrive.isConnected()){
      const ts=Date.now();const gdriveUrls=[];
      if(data.photo&&data.photo.startsWith("data:"))try{gdriveUrls.push((await GDrive.uploadPhoto(data.photo,`defect_${ts}_1.jpg`)).url);}catch{}
      if(data.extraPhotos)for(let i=0;i<data.extraPhotos.length;i++)if(data.extraPhotos[i]?.startsWith("data:"))try{gdriveUrls.push((await GDrive.uploadPhoto(data.extraPhotos[i],`defect_${ts}_${i+2}.jpg`)).url);}catch{}
      const gd={...data,companyId,storageMode:"gdrive",gdrivePhotos:JSON.stringify(gdriveUrls)};
      delete gd.photo;delete gd.extraPhotos;delete gd.photos;
      return await DB.defects.create(gd);
    }else if(storageCfg.mode==="local"&&storageCfg.localPath){
      return await DB.addDefect(companyId,{...data,storageMode:"local",storagePath:storageCfg.localPath});
    }else{
      return await DB.addDefect(companyId,data);
    }
  };

  // ── Sync offline queue ──
  const syncQueue=async()=>{
    if(syncing2||!company?.companyId)return;
    let items=[];
    try{items=await OfflineQueue.getAll();}catch{return;}
    if(!items.length)return;
    setSyncing2(true);
    let synced=0;
    for(const item of items){
      try{
        await uploadDefect(item.data,item.companyId);
        await OfflineQueue.remove(item.id);
        synced++;
        // Telegram (fire-and-forget)
        try{
          const cfg=local.get(TG_KEY);
          if(cfg?.token&&cfg?.chatId){
            const e={Critical:"\u{1F534}",Major:"\u{1F7E0}",Minor:"\u{1F7E1}",Observation:"\u{1F535}"}[item.data.severity]||"\u26AA";
            sendTelegram(cfg.token,cfg.chatId,`${e} <b>SYNCED (offline)</b>\n📋 ${sanitize(item.data.title)}\n📍 ${sanitize(item.data.location)}`).catch(()=>{});
          }
        }catch{}
      }catch(err){
        console.warn("Sync failed for queued entry:",err);
        // Stop on first failure — likely still offline
        break;
      }
    }
    const remaining=await OfflineQueue.count().catch(()=>0);
    setQueueCount(remaining);
    setSyncing2(false);
    if(synced>0)console.log(`Synced ${synced} offline entries`);
  };

  // ── Check queue count on mount and listen for online ──
  useEffect(()=>{
    OfflineQueue.count().then(c=>setQueueCount(c)).catch(()=>{});
    const onOnline=()=>{syncQueue();};
    window.addEventListener("online",onOnline);
    return()=>window.removeEventListener("online",onOnline);
  },[company?.companyId]);

  // Auto-sync when app loads and is online
  useEffect(()=>{
    if(navigator.onLine&&company?.companyId)syncQueue();
  },[company?.companyId]);

  const addDefect=async data=>{
    if(!company?.companyId||!currentProject)return;

    try{
      const saved=await uploadDefect(data,company.companyId);

      // Telegram notification (fire-and-forget)
      try{
        const cfg=local.get(TG_KEY);
        if(cfg?.token&&cfg?.chatId){
          const e={Critical:"\u{1F534}",Major:"\u{1F7E0}",Minor:"\u{1F7E1}",Observation:"\u{1F535}"}[data.severity]||"\u26AA";
          const text=`${e} <b>NEW DEFECT — ${sanitize(company.companyName)}</b>\n\n📁 ${sanitize(currentProject.name)}\n📋 <b>${sanitize(data.title)}</b>\n📍 ${sanitize(data.location)}\n⚠️ ${data.severity}\n👤 → ${sanitize(data.assignee)}\n✍️ By: ${sanitize(data.loggedBy)} (${data.loggedByRole})`;
          if(data.photo)await sendTelegramPhoto(cfg.token,cfg.chatId,data.photo,text);
          else await sendTelegram(cfg.token,cfg.chatId,text);
        }
      }catch{}
      return saved;
    }catch(err){
      // ── Offline or network error: queue for later ──
      if(!navigator.onLine||err.message?.includes("Failed to fetch")||err.message?.includes("not responding")||err.message?.includes("Cannot reach")){
        try{
          await OfflineQueue.add({data,companyId:company.companyId,projectId:currentProject.id,projectName:currentProject.name});
          const c=await OfflineQueue.count();
          setQueueCount(c);
          // Don't throw — entry is queued, show success to user
          return "queued";
        }catch(qErr){
          throw new Error("Offline and queue failed: "+qErr.message);
        }
      }
      throw err;
    }
  };

  const updateDefect=updated=>{
    setViewing(updated);
    setDefects(prev=>prev.map(d=>d.id===updated.id?updated:d));
  };

  // Bulk update — applies a patch to many defects. Returns {ok,failed}.
  const bulkUpdate=async(ids,patch)=>{
    if(!ids||!ids.length||!patch||!Object.keys(patch).length)return{ok:0,failed:0};
    const now=new Date().toISOString();
    const extra={};
    if(patch.status==="Closed")extra.closedAt=now;
    if(patch.status==="Verified"){extra.verifiedAt=now;extra.verifiedBy=member?.name||"";}
    const full={...patch,...extra,updatedAt:now};
    let ok=0,failed=0;
    const updatedMap={};
    for(const id of ids){
      try{
        await DB.defects.update(id,full);
        updatedMap[id]=full;
        ok++;
      }catch(e){console.warn("bulk update failed for",id,e);failed++;}
    }
    setDefects(prev=>prev.map(d=>updatedMap[d.id]?{...d,...updatedMap[d.id]}:d));
    // Telegram alert once for the batch
    if(patch.status&&ok>0){
      const tg=local.get(TG_KEY);
      if(tg?.token&&tg?.chatId){
        const e=STATUS_ICON[patch.status]||"⚪";
        sendTelegram(tg.token,tg.chatId,`${e} <b>Bulk Status Update</b>\n${ok} entr${ok>1?"ies":"y"} → <b>${patch.status}</b>\nBy: ${sanitize(member?.name||"")}`).catch(()=>{});
      }
    }
    return{ok,failed};
  };

  // Bulk delete — Admin-only. Deletes each defect and sweeps associated pins
  // so orphaned drawing markers don't linger. Returns {ok,failed} like bulkUpdate.
  const bulkDelete=async(ids)=>{
    if(!ids||!ids.length)return{ok:0,failed:0};
    if(member?.role!=="Admin"){alert("Only Admins can delete entries.");return{ok:0,failed:ids.length};}
    let ok=0,failed=0;
    const deletedSet=new Set();
    for(const id of ids){
      try{
        // Remove drawing pins that reference this defect (best-effort).
        try{
          const pins=await DB.pins.list(`entryId="${id}"`);
          for(const p of pins){try{await DB.pins.delete(p.id);}catch{}}
        }catch{}
        await DB.defects.delete(id);
        deletedSet.add(id);
        ok++;
      }catch(e){console.warn("bulk delete failed for",id,e);failed++;}
    }
    if(deletedSet.size)setDefects(prev=>prev.filter(d=>!deletedSet.has(d.id)));
    return{ok,failed};
  };

  const signOut=()=>{
    DB.auth.signOut();
    GDrive.disconnect();
    local.del(COMPANY_KEY);local.del(PROJECT_KEY);
    local.del(TG_KEY);local.del(GEMINI_KEY);local.del(EMAIL_KEY);local.del(AI_LIMIT_KEY);local.del(STORAGE_KEY);
    local.del(AI_PROVIDER_KEY);local.del(OLLAMA_KEY);local.del(OPENAI_KEY);
    setCompany(null);setMember(null);setAuthUser(null);
    setDefects([]);setProjects([]);setCurrentProject(null);
    setMembers([]);setMemberLoading(false);
  };

  const tgEnabled=!!(local.get(TG_KEY)?.token&&local.get(TG_KEY)?.chatId);
  const aiEnabled=isAiConfigured();
  const canLog=["Admin","Manager","Inspector"].includes(member?.role);
  const isAdmin=member?.role==="Admin";

  // Timeout: if memberLoading stays true for >8s, force it off
  useEffect(()=>{
    if(!memberLoading)return;
    const t=setTimeout(()=>setMemberLoading(false),8000);
    return()=>clearTimeout(t);
  },[memberLoading]);

  if(authLoading)return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff6b00",marginBottom:16}}>SITESHRIMP</div>
        <Spin size={24}/>
        <div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginTop:12}}>Connecting...</div>
      </div>
    </div>
  );

  // Auth check
  if(!authUser)return <AuthScreen onAuth={handleAuth} onFullSetup={handleFullSetup}/>;
  if(!company)return <CompanySetup user={authUser} inviteCode={inviteCode} onDone={handleCompanyDone} onSignOut={signOut}/>;
  if(!member)return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff6b00",marginBottom:16}}>SITESHRIMP</div>
        {memberLoading?<><Spin size={24}/><div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginTop:12}}>{t("messages.loading_workspace")}</div></>:(
          <div style={{color:"rgba(255,255,255,0.6)",fontSize:14,maxWidth:280}}>
            <div style={{marginBottom:12}}>Could not find your membership record.</div>
            <button onClick={()=>{setCompany(null);local.del(COMPANY_KEY);}} style={{background:"#ff6b00",border:"none",color:"#fff",fontSize:14,cursor:"pointer",padding:"10px 20px",borderRadius:8,marginBottom:8,width:"100%"}}>Try another company</button>
            <button onClick={signOut} style={{background:"none",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.5)",fontSize:13,cursor:"pointer",padding:"8px 16px",borderRadius:8,width:"100%"}}>Sign out</button>
          </div>
        )}
      </div>
    </div>
  );

  const navItems=NAV.filter(n=>{
    if(n.id==="log"&&!canLog)return false;
    return true;
  });

  // Setup progress — counts optional setup items that actually add value.
  // Storage is excluded because its default (PocketBase) is already a valid choice.
  const setupChecks={
    project:(projects?.length||0)>0,
    team:isAdmin?(members?.length||0)>1:true,
    ai:!!aiEnabled,
    telegram:!!tgEnabled,
  };
  const setupTotal=Object.keys(setupChecks).length;
  const setupDone=Object.values(setupChecks).filter(Boolean).length;
  const setupComplete=setupDone===setupTotal;

  return(
    <div style={{width:"100%",maxWidth:430,margin:"0 auto",height:"100dvh",background:"#f0ede8",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* Header */}
        <div style={{background:"#1a1a1a",padding:"10px 12px 8px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,position:"relative"}}>
          <button onClick={()=>setShowProjects(true)} style={{background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0,flex:1,minWidth:0,maxWidth:"calc(100% - 240px)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:8.5,fontWeight:700,color:"#ff6b00",letterSpacing:"0.13em",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{company.companyName}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:13.5,fontWeight:800,color:"#fff",marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {currentProject?.name||t("dashboard.select_project")} <span style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>▼</span>
          </div>
        </button>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"nowrap",justifyContent:"flex-end",flexShrink:0}}>
          {/* Settings dropdown — all one-time setup in one place */}
          <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(settingsMenuTimer.current);setShowSettingsMenu(true);}} onMouseLeave={()=>{settingsMenuTimer.current=setTimeout(()=>setShowSettingsMenu(false),250);}}>
            <button onClick={()=>setShowSettingsMenu(v=>!v)} title="Settings" style={{position:"relative",width:34,height:34,borderRadius:9,background:showSettingsMenu?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${showSettingsMenu?"rgba(255,107,0,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:17,color:showSettingsMenu?"#ff6b00":"rgba(255,255,255,0.75)",flexShrink:0}}>⚙
            </button>
            {showSettingsMenu&&(()=>{
              const donePill={background:"rgba(48,209,88,0.15)",color:"#30d158",border:"1px solid rgba(48,209,88,0.3)"};
              const todoPill={background:"rgba(255,149,0,0.12)",color:"#ff9500",border:"1px solid rgba(255,149,0,0.28)"};
              const optPill={background:"rgba(255,255,255,0.06)",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)"};
              const headerPct=Math.round((setupDone/setupTotal)*100);
              const items=[
                {section:t("settings.section_project")},
                {label:t("settings.projects"),desc:t("settings.projects_desc"),icon:"folder",done:setupChecks.project,onClick:()=>{setShowProjects(true);setShowSettingsMenu(false);}},
                ...(isAdmin?[{label:t("settings.team"),desc:t("settings.team_desc"),icon:"users",done:setupChecks.team,onClick:()=>{setShowUsers(true);setShowSettingsMenu(false);}}]:[]),
                {section:t("settings.section_enhance")},
                {label:t("settings.ai_setup"),desc:t("settings.ai_desc"),icon:"ai",done:setupChecks.ai,onClick:()=>{setShowGemini(true);setShowSettingsMenu(false);}},
                {label:t("settings.telegram"),desc:t("settings.telegram_desc"),icon:"plane",done:setupChecks.telegram,onClick:()=>{setShowTg(true);setShowSettingsMenu(false);}},
                {label:t("settings.storage"),desc:t("settings.storage_desc"),icon:"disk",optional:true,onClick:()=>{setShowStorage(true);setShowSettingsMenu(false);}},
                {label:t("settings.maps"),desc:t("settings.maps_desc"),icon:"pin",optional:true,onClick:()=>{setShowMaps(true);setShowSettingsMenu(false);}},
                {section:t("language.title")},
                {label:t("settings.language"),desc:(languages.find(l=>l.code===lang)||{}).name||"English",icon:"globe",optional:true,onClick:()=>{setShowLangPicker(true);setShowSettingsMenu(false);}},
                {section:t("settings.section_app")},
                {label:t("settings.clear_cache"),desc:t("settings.clear_cache_desc"),icon:"refresh",optional:true,onClick:async()=>{if("caches"in window){const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));}if(navigator.serviceWorker){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()));}setShowSettingsMenu(false);window.location.reload(true);}},
              ];
              return(
              <div className="dd-panel" onMouseEnter={()=>clearTimeout(settingsMenuTimer.current)} onMouseLeave={()=>{settingsMenuTimer.current=setTimeout(()=>setShowSettingsMenu(false),250);}} style={{position:"absolute",top:"100%",right:0,marginTop:8,background:"linear-gradient(180deg,#2e2e32 0%,#1f1f22 100%)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:14,overflow:"hidden",zIndex:1200,minWidth:278,boxShadow:"0 16px 48px rgba(0,0,0,0.55),0 2px 10px rgba(0,0,0,0.35)"}}>
                {/* Header */}
                <div style={{padding:"13px 16px 12px",borderBottom:"1px solid rgba(255,255,255,0.06)",background:"linear-gradient(180deg,rgba(255,107,0,0.06),rgba(255,107,0,0))"}}>
                  <div style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.14em",fontFamily:"'Barlow Condensed',sans-serif"}}>{t("settings.title")}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff",marginTop:2,lineHeight:1}}>{setupComplete?t("settings.all_set"):t("settings.title")}</div>
                </div>
                {/* Rows */}
                <div style={{padding:"6px 0 8px"}}>
                  {items.map((it,i)=>it.section?(
                    <div key={`s${i}`} style={{padding:"10px 16px 4px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.35)",letterSpacing:"0.14em",fontFamily:"'Barlow Condensed',sans-serif"}}>{it.section}</div>
                  ):(
                    <button key={it.label} className="dd-row" onClick={it.onClick}>
                      <div className="dd-ico"><DdIcon name={it.icon}/></div>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="dd-label">{it.label}</div>
                        <div className="dd-sub">{it.desc}</div>
                      </div>
                      <span className="dd-pill" style={it.optional?optPill:(it.done?donePill:todoPill)}>{it.optional?t("settings.opt_pill"):(it.done?t("settings.done_pill"):t("settings.todo_pill"))}</span>
                    </button>
                  ))}
                </div>
              </div>
              );
            })()}
          </div>
          {/* Help button */}
          <button onClick={()=>setShowHelp(true)} title={t("avatar_menu.help")} style={{width:34,height:34,borderRadius:9,background:showHelp?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${showHelp?"rgba(255,107,0,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:showHelp?"#ff6b00":"rgba(255,255,255,0.75)",flexShrink:0}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5c.5-1.5 1.5-2 2.5-2 1.5 0 2.5 1 2.5 2.3 0 1.2-.8 1.7-1.5 2.2-.8.5-1 1-1 2"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>
          </button>
          {/* Avatar dropdown — profile, admin analytics, feedback, sign out */}
          <div style={{position:"relative"}} onMouseEnter={()=>{clearTimeout(avatarMenuTimer.current);setShowAvatarMenu(true);}} onMouseLeave={()=>{avatarMenuTimer.current=setTimeout(()=>setShowAvatarMenu(false),250);}}>
            <button onClick={()=>setShowAvatarMenu(v=>!v)} style={{width:34,height:34,borderRadius:"50%",background:"#ff6b00",border:showAvatarMenu?"2px solid #fff":"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",flexShrink:0}}>
              {(member?.name||"?")[0].toUpperCase()}
            </button>
            {showAvatarMenu&&(
              <div className="dd-panel" onMouseEnter={()=>clearTimeout(avatarMenuTimer.current)} onMouseLeave={()=>{avatarMenuTimer.current=setTimeout(()=>setShowAvatarMenu(false),250);}} style={{position:"absolute",top:"100%",right:0,marginTop:8,background:"linear-gradient(180deg,#2e2e32 0%,#1f1f22 100%)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:14,overflow:"hidden",zIndex:1200,minWidth:258,boxShadow:"0 16px 48px rgba(0,0,0,0.55),0 2px 10px rgba(0,0,0,0.35)"}}>
                {/* Profile header */}
                <div style={{padding:"14px 16px 12px",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",alignItems:"center",gap:12,background:"linear-gradient(180deg,rgba(255,107,0,0.08),rgba(255,107,0,0))"}}>
                  <div style={{width:42,height:42,borderRadius:"50%",background:"linear-gradient(135deg,#ff8a3d,#ff6b00)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"#fff",boxShadow:"0 4px 12px rgba(255,107,0,0.35)",flexShrink:0}}>
                    {(member?.name||"?")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{member?.name||"—"}</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginTop:1}}>{member?.role||""}{member?.jobTitle?` · ${member.jobTitle}`:""}</div>
                  </div>
                </div>
                {/* Rows */}
                <div style={{padding:"6px 0"}}>
                  <button className="dd-row" onClick={()=>{setShowProfile(true);setShowAvatarMenu(false);}}>
                    <div className="dd-ico"><DdIcon name="user"/></div>
                    <div style={{flex:1,minWidth:0}}><div className="dd-label">{t("avatar_menu.profile")}</div><div className="dd-sub">{t("profile.account")}</div></div>
                  </button>
                  {isAdmin&&(
                    <button className="dd-row" onClick={()=>{setShowAdminAnalytics(true);setShowAvatarMenu(false);}}>
                      <div className="dd-ico"><DdIcon name="chart"/></div>
                      <div style={{flex:1,minWidth:0}}><div className="dd-label">{t("avatar_menu.admin_analytics")}</div><div className="dd-sub">{t("avatar_menu.usage_insights")}</div></div>
                    </button>
                  )}
                  <button className="dd-row" onClick={()=>{setShowFeedback(true);setFbSent(false);setFbText("");setShowAvatarMenu(false);}}>
                    <div className="dd-ico"><DdIcon name="chat"/></div>
                    <div style={{flex:1,minWidth:0}}><div className="dd-label">{t("avatar_menu.feedback")}</div><div className="dd-sub">{t("avatar_menu.send_note")}</div></div>
                  </button>
                </div>
                {/* Sign out footer */}
                <div style={{borderTop:"1px solid rgba(255,255,255,0.06)",padding:"6px 0"}}>
                  <button className="dd-row danger" onClick={()=>{setShowAvatarMenu(false);signOut();}}>
                    <div className="dd-ico" style={{color:"#ff8f8f",borderColor:"rgba(255,143,143,0.3)"}}><DdIcon name="logout"/></div>
                    <div style={{flex:1,minWidth:0}}><div className="dd-label" style={{color:"#ff8f8f"}}>{t("avatar_menu.sign_out")}</div><div className="dd-sub">{t("avatar_menu.end_session")}</div></div>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AI Query bar — shown on Dashboard and Report tabs */}
      {(tab==="dashboard"||tab==="report")&&(
        <div style={{background:"#1a1a1a",padding:"0 12px 10px"}}>
          <button onClick={()=>{if(aiEnabled)setShowAiSearch(true);}} title={aiEnabled?"AI natural-language query across your entries":"Configure AI in Settings to enable"} style={{width:"100%",display:"flex",alignItems:"center",gap:10,background:aiEnabled?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.04)",border:`1px solid ${aiEnabled?"rgba(255,107,0,0.35)":"rgba(255,255,255,0.08)"}`,borderRadius:10,padding:"9px 12px",cursor:aiEnabled?"pointer":"not-allowed",textAlign:"left"}}>
            <span style={{fontSize:14,color:aiEnabled?"#ff6b00":"rgba(255,255,255,0.3)"}}>💬</span>
            <span style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:aiEnabled?"rgba(255,255,255,0.75)":"rgba(255,255,255,0.35)",letterSpacing:"0.04em"}}>{aiEnabled?t("ai.query_enabled"):t("ai.query_disabled")}</span>
            {aiEnabled&&<span style={{fontSize:10,fontWeight:800,color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif",background:"rgba(255,107,0,0.12)",border:"1px solid rgba(255,107,0,0.3)",borderRadius:8,padding:"2px 7px"}}>ASK</span>}
          </button>
        </div>
      )}

      {/* Profile panel */}
      {showProfile&&<ProfilePanel member={member} authUser={authUser} company={company} onClose={()=>setShowProfile(false)} onSignOut={signOut} onCompanyUpdate={(name)=>setCompany(prev=>prev?{...prev,companyName:name}:prev)}/>}

      {/* Main content */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:84}}>
        {tab==="dashboard"&&<Dashboard defects={defects} onView={setViewing} tgEnabled={tgEnabled} aiEnabled={aiEnabled} syncing={syncing} company={company} currentProject={currentProject} member={member} onDrawings={()=>setTab("drawings")} queueCount={queueCount} onSyncQueue={syncQueue} syncing2={syncing2} onBulkDelete={bulkDelete}/>}
        {tab==="log"&&canLog&&<LogDefect member={member} company={company} currentProject={currentProject} members={members} onSave={addDefect} existingDefects={defects} onViewEntry={d=>{setViewing(d);setTab("defects");}} onTagDrawing={()=>setTab("drawings")}/>}
        {tab==="log"&&!canLog&&<div style={{padding:40,textAlign:"center",color:"rgba(0,0,0,0.4)",fontSize:14}}>{t("log.viewer_disabled")}</div>}
        {tab==="drawings"&&<DrawingsPanel embedded onClose={()=>setTab("dashboard")} company={company} currentProject={currentProject} member={member} defects={defects} onSaveEntry={addDefect}/>}
        {tab==="defects"&&<DefectsList defects={defects} onView={setViewing} nlFilters={nlFilters} onClearNl={()=>setNlFilters(null)} onAiSearch={()=>setShowAiSearch(true)} aiEnabled={aiEnabled} member={member} members={members} onBulkUpdate={bulkUpdate} onBulkDelete={bulkDelete} company={company} currentProject={currentProject}/>}
        {tab==="report"&&<Report defects={defects} onEmailSetup={()=>setShowEmail(true)} currentProject={currentProject} company={company}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#1a1a1a",borderTop:"1px solid rgba(255,255,255,0.06)",display:"flex",padding:"10px 0 14px",zIndex:50}}>
        {navItems.map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"4px 0"}}>
            <div style={{height:26,display:"flex",alignItems:"center",justifyContent:"center",fontSize:n.id==="log"?28:22,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.55)",fontWeight:700,lineHeight:1,fontFamily:n.id==="log"?"'Barlow Condensed',sans-serif":"inherit"}}>{n.icon}</div>
            <div style={{fontSize:11,fontWeight:700,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em",lineHeight:1}}>{t(n.labelKey).toUpperCase()}</div>
          </button>
        ))}
      </div>

      {/* Overlays */}
      {showAiSearch&&<AiSearch defects={defects} onClose={()=>setShowAiSearch(false)} onApplyFilters={f=>{setNlFilters(f);setTab("defects");}}/>}
      {viewing&&<DefectDetail defect={viewing} onClose={()=>setViewing(null)} onUpdate={updateDefect} member={member} company={company} members={members} allDefects={defects}/>}
      {showHelp&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"#1a1a1a",overflowY:"auto"}}>
          <div style={{maxWidth:430,margin:"0 auto",padding:"0 0 40px"}}>
            <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:1}}>
              <button onClick={()=>setShowHelp(false)} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{t("actions.back")}</button>
              <div style={{display:"flex",gap:0,flex:1}}>
                <button onClick={()=>setHelpTab("help")} style={{flex:1,padding:"8px 0",background:"none",border:"none",borderBottom:helpTab==="help"?"2px solid #ff6b00":"2px solid transparent",color:helpTab==="help"?"#fff":"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{t("help.title").toUpperCase()}</button>
                <button onClick={()=>setHelpTab("hosting")} style={{flex:1,padding:"8px 0",background:"none",border:"none",borderBottom:helpTab==="hosting"?"2px solid #34a853":"2px solid transparent",color:helpTab==="hosting"?"#fff":"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>HOSTING</button>
                <button onClick={()=>setHelpTab("features")} style={{flex:1,padding:"8px 0",background:"none",border:"none",borderBottom:helpTab==="features"?"2px solid #ff6b00":"2px solid transparent",color:helpTab==="features"?"#fff":"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{t("help.features")}</button>
              </div>
            </div>
            <div style={{padding:"20px 16px"}}>

              {/* ── HELP TAB ── */}
              {helpTab==="help"&&(
                <div>
                  {[
                    [t("help.problem"),[
                      ["",t("help.problem_desc")],
                    ]],
                    [t("help.what_it_does"),[
                      ["",t("help.what_it_does_desc")],
                    ]],
                    [t("help.who_its_for"),[
                      [t("help.audience_developers"),t("help.audience_developers_desc")],
                      [t("help.audience_fm"),t("help.audience_fm_desc")],
                      [t("help.audience_renovation"),t("help.audience_renovation_desc")],
                      [t("help.audience_consultants"),t("help.audience_consultants_desc")],
                      [t("help.audience_smes"),t("help.audience_smes_desc")],
                    ]],
                    [t("help.first_time_setup"),[
                      ["",t("help.setup_1")],
                      ["",t("help.setup_2")],
                      ["",t("help.setup_3")],
                      ["",t("help.setup_4")],
                      ["",t("help.setup_5")],
                    ]],
                    [t("help.main_nav"),[
                      [t("help.nav_dashboard"),t("help.nav_dashboard_desc")],
                      [t("help.nav_log"),t("help.nav_log_desc")],
                      [t("help.nav_tag"),t("help.nav_tag_desc")],
                      [t("help.nav_review"),t("help.nav_review_desc")],
                      [t("help.nav_report"),t("help.nav_report_desc")],
                    ]],
                    [t("log.logging_entry"),[
                      ["",t("help.log_1")],
                      ["",t("help.log_2")],
                      ["",t("help.log_3")],
                      ["",t("help.log_4")],
                      ["",t("help.log_5")],
                      ["",t("help.log_6")],
                      ["",t("help.log_7")],
                    ]],
                    [t("help.tag_compare"),[
                      ["",t("help.tag_compare_desc")],
                    ]],
                    [t("status.flow_title"),[
                      [t("status.open"),t("status.open_desc")],
                      [t("status.in_progress"),t("status.in_progress_desc")],
                      [t("status.done"),t("status.done_desc")],
                      [t("status.verified"),t("status.verified_desc")],
                      [t("status.closed"),t("status.closed_desc")],
                    ]],
                    [t("help.top_bar"),[
                      [t("help.top_project"),t("help.top_project_desc")],
                      [t("help.top_settings"),t("help.top_settings_desc")],
                      [t("help.top_avatar"),t("help.top_avatar_desc")],
                      [t("help.top_ai_query"),t("help.top_ai_query_desc")],
                    ]],
                    [t("help.settings_items"),[
                      [t("help.set_projects"),t("help.set_projects_desc")],
                      [t("help.set_team"),t("help.set_team_desc")],
                      [t("help.set_ai"),t("help.set_ai_desc")],
                      [t("help.set_telegram"),t("help.set_telegram_desc")],
                      [t("help.set_storage"),t("help.set_storage_desc")],
                      [t("help.set_maps"),t("help.set_maps_desc")],
                      [t("help.set_language"),t("help.set_language_desc")],
                    ]],
                    [t("help.practical_tips"),[
                      [t("messages.offline_use"),t("messages.offline_continue")],
                      [t("help.tip_multi_projects"),t("help.tip_multi_projects_desc")],
                      [t("help.tip_export"),t("help.tip_export_desc")],
                      [t("help.tip_advisor"),t("help.tip_advisor_desc")],
                      [t("onboarding.voice_input"),t("onboarding.voice_tip")],
                      [t("log.batch_logging"),t("log.reuse_location_tip")],
                      [t("help.tip_language"),t("help.tip_language_desc")],
                      [t("help.tip_batch_update"),t("help.tip_batch_update_desc")],
                      [t("help.tip_drawing_gestures"),t("help.tip_drawing_gestures_desc")],
                      [t("help.tip_photo_scale"),t("help.tip_photo_scale_desc")],
                      [t("help.tip_map_tagging"),t("help.tip_map_tagging_desc")],
                      [t("help.tip_map_markup"),t("help.tip_map_markup_desc")],
                      [t("help.tip_cluster_pins"),t("help.tip_cluster_pins_desc")],
                      [t("help.tip_convert"),t("help.tip_convert_desc")],
                      [t("help.tip_load_samples"),t("help.tip_load_samples_desc")],
                      [t("help.tip_save_device"),t("help.tip_save_device_desc")],
                      [t("help.tip_bulk_delete"),t("help.tip_bulk_delete_desc")],
                    ]],
                  ].map(([section,items])=>(
                    <div key={section} style={{marginBottom:24}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:800,color:"#ff6b00",letterSpacing:"0.08em",marginBottom:10,borderBottom:"1px solid rgba(255,255,255,0.1)",paddingBottom:6}}>{section.toUpperCase()}</div>
                      {items.map(([title,desc],i)=>(
                        <div key={i} style={{marginBottom:10}}>
                          {title&&<div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#fff",marginBottom:2}}>{title}</div>}
                          <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>{desc}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* ── HOSTING TAB ── */}
              {helpTab==="hosting"&&(
                <div>
                  {/* Intro */}
                  <div style={{background:"rgba(52,168,83,0.08)",border:"1px solid rgba(52,168,83,0.2)",borderRadius:12,padding:16,marginBottom:20}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:"#34a853",marginBottom:6}}>OWN YOUR DATA</div>
                    <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7}}>SiteShrimp is designed for self-hosting. You control your backend, storage, AI, language, and reporting. No vendor lock-in, no recurring fees. 22 languages built in.</div>
                  </div>

                  {/* PocketBase */}
                  {(()=>{
                    const Link=({href,children})=>React.createElement("a",{href,target:"_blank",rel:"noopener",style:{color:"#ff6b00",textDecoration:"underline",fontWeight:600}},children);
                    const Step=({n,children})=>React.createElement("div",{style:{display:"flex",gap:10,marginBottom:10,alignItems:"flex-start"}},
                      React.createElement("div",{style:{width:22,height:22,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}},n),
                      React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.55)",lineHeight:1.6,paddingTop:2}},children)
                    );
                    const Section=({icon,title,color,children})=>React.createElement("div",{style:{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:16,marginBottom:16,borderLeft:"4px solid "+color}},
                      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,marginBottom:12}},
                        React.createElement("span",{style:{fontSize:20}},icon),
                        React.createElement("div",{style:{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color}},title)
                      ),
                      children
                    );

                    return React.createElement(React.Fragment,null,
                      // PocketBase Section
                      React.createElement(Section,{icon:"🗄",title:"POCKETBASE — YOUR BACKEND",color:"#ff6b00"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"PocketBase is a single-file backend. One executable gives you authentication, database, file storage, and real-time sync. Perfect for small teams or private deployments."),
                        React.createElement("div",{style:{fontSize:11,color:"#ff9500",fontWeight:700,marginBottom:6,letterSpacing:"0.06em"}},"QUICK START (5 MINUTES)"),
                        React.createElement(Step,{n:"1"},React.createElement(React.Fragment,null,"Download the binary for your OS from ",React.createElement(Link,{href:"https://pocketbase.io/docs/"},"pocketbase.io/docs"),".")),
                        React.createElement(Step,{n:"2"},React.createElement(React.Fragment,null,"Unzip it, then run:",React.createElement("pre",{style:{background:"rgba(0,0,0,0.4)",borderRadius:6,padding:"6px 10px",fontSize:11,color:"#ff9500",marginTop:4,overflowX:"auto"}},"./pocketbase serve"))),
                        React.createElement(Step,{n:"3"},React.createElement(React.Fragment,null,"Open ",React.createElement(Link,{href:"http://127.0.0.1:8090/_/"},"http://127.0.0.1:8090/_/")," and create your admin account.")),
                        React.createElement(Step,{n:"4"},React.createElement(React.Fragment,null,"On the SiteShrimp login page, expand ⚙ ",React.createElement("b",null,"Change server URL")," and paste your PocketBase address (e.g. ",React.createElement("code",{style:{background:"rgba(0,0,0,0.4)",padding:"1px 5px",borderRadius:4,fontSize:11}},"http://127.0.0.1:8090"),"), then Set.")),
                        React.createElement(Step,{n:"5"},"Log in and the app will auto-create the collections it needs on first use."),

                        React.createElement("div",{style:{fontSize:11,color:"#ff9500",fontWeight:700,marginTop:16,marginBottom:6,letterSpacing:"0.06em"}},"PUBLIC HTTPS — PICK ONE"),
                        React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.7,marginBottom:8}},"PocketBase speaks HTTP out of the box. For phones outside your LAN, put it behind HTTPS using any of:"),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:5}},
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"},"Cloudflare Tunnel")," — free, no open ports, handles TLS automatically")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://caddyserver.com/docs/quick-starts/reverse-proxy"},"Caddy")," — one-liner reverse proxy with automatic Let's Encrypt certs")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://nginx.org/en/docs/http/configuring_https_servers.html"},"Nginx")," + ",React.createElement(Link,{href:"https://certbot.eff.org/"},"Certbot")," — traditional stack if you already run Nginx")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},"• Use PocketBase's built-in auto-TLS: ",React.createElement("code",{style:{background:"rgba(0,0,0,0.4)",padding:"1px 5px",borderRadius:4,fontSize:11}},"./pocketbase serve --https=yourdomain.com:443"))
                        ),

                        React.createElement("div",{style:{fontSize:11,color:"#ff9500",fontWeight:700,marginTop:16,marginBottom:6,letterSpacing:"0.06em"}},"KEEP IT RUNNING"),
                        React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.7,marginBottom:8}},"When you close the terminal, PocketBase stops. Run it as a service so it survives reboots:"),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:5}},
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement("b",null,"Linux")," — create a ",React.createElement(Link,{href:"https://pocketbase.io/docs/going-to-production/"},"systemd unit")," (recommended for GCP/Oracle/DigitalOcean VMs)")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement("b",null,"Windows")," — use ",React.createElement(Link,{href:"https://nssm.cc/"},"NSSM")," to install it as a Windows service")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement("b",null,"macOS")," — create a launchd plist in ~/Library/LaunchAgents")),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement("b",null,"Docker")," — official image at ",React.createElement(Link,{href:"https://hub.docker.com/r/spectado/pocketbase"},"hub.docker.com/r/spectado/pocketbase")))
                        ),

                        React.createElement("div",{style:{fontSize:11,color:"#ff9500",fontWeight:700,marginTop:16,marginBottom:6,letterSpacing:"0.06em"}},"BACKUP YOUR DATA"),
                        React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.45)",lineHeight:1.7}},React.createElement(React.Fragment,null,"All data lives in the ",React.createElement("code",{style:{background:"rgba(0,0,0,0.4)",padding:"1px 5px",borderRadius:4,fontSize:11}},"pb_data/")," folder (SQLite + uploaded files). Copy this folder to back up. PocketBase Admin UI also has a one-click Backup button under Settings.")),

                        React.createElement("div",{style:{background:"rgba(255,149,0,0.1)",borderRadius:8,padding:"10px 12px",marginTop:12}},
                          React.createElement("div",{style:{fontSize:11,color:"#ff9500",lineHeight:1.6,fontWeight:600}},"WHERE TO HOST"),
                          React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.4)",lineHeight:1.7,marginTop:4}},
                            React.createElement(React.Fragment,null,
                              "• Your own laptop/PC (testing, LAN-only use)\n",
                              "• ",React.createElement(Link,{href:"https://cloud.google.com/free"},"Google Cloud (GCP)")," — free e2-micro VM\n",
                              "• ",React.createElement(Link,{href:"https://www.oracle.com/cloud/free/"},"Oracle Cloud")," — always-free ARM Ampere VMs (4 CPU / 24 GB RAM!)\n",
                              "• ",React.createElement(Link,{href:"https://www.vultr.com/"},"Vultr")," / ",React.createElement(Link,{href:"https://www.digitalocean.com/"},"DigitalOcean")," / ",React.createElement(Link,{href:"https://www.hetzner.com/cloud"},"Hetzner")," — $4–6/mo VPS\n",
                              "• ",React.createElement(Link,{href:"https://fly.io/"},"Fly.io")," — free tier with auto-deploy\n",
                              "• ",React.createElement(Link,{href:"https://railway.app/"},"Railway")," / ",React.createElement(Link,{href:"https://www.pockethost.io/"},"PocketHost")," — one-click managed PocketBase"
                            )
                          )
                        )
                      ),
                      // Google Sheets Section
                      React.createElement(Section,{icon:"📊",title:"GOOGLE SHEETS — LIVE REPORTS",color:"#34a853"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"Export filtered defect reports directly into Google Sheets. Each export creates a new tab with summary stats (severity, status, cost breakdown) and full data rows. Also export as CSV, PDF, or all-in-one bundle from the Report tab."),
                        React.createElement(Step,{n:"1"},React.createElement(React.Fragment,null,"Go to ",React.createElement(Link,{href:"https://console.cloud.google.com/"},"Google Cloud Console"))),
                        React.createElement(Step,{n:"2"},"Create a project (or use an existing one)"),
                        React.createElement(Step,{n:"3"},React.createElement(React.Fragment,null,"Enable ",React.createElement(Link,{href:"https://console.cloud.google.com/apis/library/sheets.googleapis.com"},"Google Sheets API")," and ",React.createElement(Link,{href:"https://console.cloud.google.com/apis/library/drive.googleapis.com"},"Google Drive API"))),
                        React.createElement(Step,{n:"4"},React.createElement(React.Fragment,null,"Go to ",React.createElement(Link,{href:"https://console.cloud.google.com/apis/credentials"},"Credentials")," → Create OAuth 2.0 Client ID (Web)")),
                        React.createElement(Step,{n:"5"},"Add your SiteShrimp URL as Authorized JavaScript Origin"),
                        React.createElement(Step,{n:"6"},"Copy the Client ID → Settings ⚙ → Storage → Google Sheets section"),
                        React.createElement(Step,{n:"7"},"Report tab → Export ▾ → Google Sheets → Sign in & export"),
                        React.createElement("div",{style:{background:"rgba(52,168,83,0.1)",borderRadius:8,padding:"10px 12px",marginTop:10}},
                          React.createElement("div",{style:{fontSize:11,color:"#34a853",fontWeight:600}},"Your spreadsheet is in YOUR Google Drive. Share it with your team, add charts, or connect to other tools.")
                        )
                      ),
                      // AI Section
                      React.createElement(Section,{icon:"🤖",title:"AI — YOUR OWN MODELS",color:"#5856d6"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"Use any AI provider for photo analysis, auto-fill (title, severity, trade, assignee), natural-language search, PDF diff reports, and Contract Advisor (clause-to-defect mapping using PSSCOC/REDAS/SIA). You choose the model, you control the cost."),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:8}},
                          React.createElement("div",{style:{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"10px 12px"}},
                            React.createElement("div",{style:{fontSize:12,fontWeight:700,color:"#5856d6",marginBottom:4}},"GOOGLE GEMINI (Free)"),
                            React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"Get a free API key from ",React.createElement(Link,{href:"https://aistudio.google.com/apikey"},"Google AI Studio"),". 1,500 analyses/day free."))
                          ),
                          React.createElement("div",{style:{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"10px 12px"}},
                            React.createElement("div",{style:{fontSize:12,fontWeight:700,color:"#5856d6",marginBottom:4}},"OLLAMA (Local / Private)"),
                            React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"Run AI on your own machine. Install from ",React.createElement(Link,{href:"https://ollama.ai/"},"ollama.ai"),", then: ollama pull llava"))
                          ),
                          React.createElement("div",{style:{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"10px 12px"}},
                            React.createElement("div",{style:{fontSize:12,fontWeight:700,color:"#5856d6",marginBottom:4}},"OPENAI / GPT (or Compatible)"),
                            React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"Use ",React.createElement(Link,{href:"https://platform.openai.com/api-keys"},"OpenAI"),", ",React.createElement(Link,{href:"https://azure.microsoft.com/en-us/products/ai-services/openai-service"},"Azure OpenAI"),", ",React.createElement(Link,{href:"https://lmstudio.ai/"},"LM Studio"),", or any OpenAI-compatible API."))
                          )
                        )
                      ),
                      // Telegram Section
                      React.createElement(Section,{icon:"📢",title:"TELEGRAM — INSTANT ALERTS",color:"#0088cc"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"Get real-time notifications in your team's Telegram group when defects are logged, status changes, or comments are added."),
                        React.createElement(Step,{n:"1"},React.createElement(React.Fragment,null,"Open Telegram → search ",React.createElement(Link,{href:"https://t.me/BotFather"},"@BotFather")," → /newbot → follow steps → copy Bot Token")),
                        React.createElement(Step,{n:"2"},"Create a group → add your bot → promote to Admin"),
                        React.createElement(Step,{n:"3"},React.createElement(React.Fragment,null,"Forward a message from the group to ",React.createElement(Link,{href:"https://t.me/userinfobot"},"@userinfobot")," → get Chat ID")),
                        React.createElement(Step,{n:"4"},"Settings ⚙ → Telegram → paste Bot Token + Chat ID → Test")
                      ),
                      // Email Section
                      React.createElement(Section,{icon:"📧",title:"EMAIL — SMTP REPORTS",color:"#ff3b30"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"Send translated HTML email reports directly from the app. Choose which sections to include (defects, drawings, comparisons). Uses your own email provider via SMTP."),
                        React.createElement(Step,{n:"1"},"Settings ⚙ → open the Report tab"),
                        React.createElement(Step,{n:"2"},"Click 📧 EMAIL → Edit Recipients → choose your email provider"),
                        React.createElement(Step,{n:"3"},React.createElement(React.Fragment,null,"For Gmail: ",React.createElement(Link,{href:"https://myaccount.google.com/apppasswords"},"Generate App Password")," (requires 2-Step Verification)")),
                        React.createElement(Step,{n:"4"},"Enter email + app password → Save → Test")
                      ),
                      // Storage Section
                      React.createElement(Section,{icon:"💾",title:"STORAGE — YOUR FILES",color:"#ff9500"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"Choose where photos and files are stored. All options keep data under your control."),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:6}},
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• PocketBase (default) — files stored on your PocketBase server"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• Local Path — save to any folder on your server or machine"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://drive.google.com/"},"Google Drive")," — photos in your personal Drive"))
                        ),
                        React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginTop:8}},"Configure in Settings ⚙ → Storage")
                      ),
                      // Language Section
                      React.createElement(Section,{icon:"🌐",title:"LANGUAGE — 22 LANGUAGES BUILT IN",color:"#00bcd4"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"The entire app is translated into 22 languages — UI labels, buttons, dropdown options (158 components, 296 issues, levels, zones, rooms, durations, costs), and email reports. Switch anytime from Settings → Language."),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:6}},
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• English, 简体中文, 繁體中文, Bahasa Melayu, Bahasa Indonesia"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• हिन्दी, தமிழ், ไทย, Tiếng Việt, বাংলা"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• 日本語, 한국어"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• Deutsch, Français, Español, Português, Italiano"),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• Türkçe, Svenska, Norsk, Dansk, Suomi")
                        ),
                        React.createElement("div",{style:{background:"rgba(0,188,212,0.1)",borderRadius:8,padding:"10px 12px",marginTop:10}},
                          React.createElement("div",{style:{fontSize:11,color:"#00bcd4",fontWeight:600}},"All construction terms use proper industry vocabulary per language. Values stored in English for data consistency; display is translated.")
                        )
                      ),
                      // Frontend Hosting Section
                      React.createElement(Section,{icon:"🌍",title:"FRONTEND — DEPLOY ANYWHERE",color:"#607d8b"},
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:12}},"SiteShrimp is a static site (HTML + JS + CSS). Host it on any static hosting provider. No server-side rendering needed."),
                        React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:6}},
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://pages.github.com/"},"GitHub Pages")," — free, auto-deploy from main branch")),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://pages.cloudflare.com/"},"Cloudflare Pages")," — free, fast global CDN")),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},React.createElement(React.Fragment,null,"• ",React.createElement(Link,{href:"https://vercel.com/"},"Vercel")," / ",React.createElement(Link,{href:"https://www.netlify.com/"},"Netlify")," — free tier, one-click deploy")),
                          React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"• Any web server (Nginx, Apache, Caddy) — just serve the files")
                        ),
                        React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginTop:8}},"Push to your repo and the frontend updates automatically. Backend (PocketBase) runs separately on your VM.")
                      ),
                      // Summary
                      React.createElement("div",{style:{background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:12,padding:16,textAlign:"center"}},
                        React.createElement("div",{style:{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:800,color:"#ff6b00",marginBottom:6}},"SELF-HOSTED. SELF-CONTROLLED."),
                        React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",lineHeight:1.7}},"Your backend. Your AI. Your storage. Your language. Your reports. No subscription fees. No data lock-in. Built for teams that own their tools.")
                      )
                    );
                  })()}
                </div>
              )}

              {/* ── FEATURES TAB ── */}
              {helpTab==="features"&&(
                <div>
                  {(()=>{const fc=[
                    ["Navigation",["Minimal top bar: Project selector, Settings dropdown, Avatar dropdown","Bottom nav: Dashboard → Log → Tag → Review → Report","Operational flow order: see state → capture → tag → act → share","Settings dropdown with setup-progress badge (N/4 configured)","Settings menu groups: PROJECT (Projects, Team) + ENHANCE (AI, Telegram, Storage, Language)","Avatar menu: Profile, Admin Analytics (admin), Help, Feedback, Sign Out","Setup progress ✓ / — indicators on each Settings item","Inline AI Query bar on Dashboard and Report tabs"]],
                    ["Auth & Onboarding",["Login / Sign up","Password reset","Password visibility toggle","One-step registration + company setup","Auto-recover session","Install as app","Server URL config — point the app at your own PocketBase","Inline 'How do I run my own PocketBase?' quick-start on the login screen","Reset-to-default button for the server URL"]],
                    ["Team",["Invite members (link + code)","Role-based access (Admin, Manager, Inspector, Viewer)","Edit roles / remove members","Permission matrix display"]],
                    ["Projects",["Create / rename projects","Switch active project","Archive / restore projects"]],
                    ["Entry Logging",["7 Work Categories (Landed, Highrise, Construction, Interior, FM, Infra, Others)","Log with title, severity, location","4 default types + custom entry types","Custom type manager (icon & color picker)","Multi-level location (Level > Zone > Room > Grid)","Low-friction submit: description OR photo is enough","Snap / upload up to 10 photos","Photo markup editor (arrows, circles, freehand, text)","Markup scales correctly on save (pen, text, arrows)","Edit / delete text annotations on markup","AI photo analysis (Gemini, Ollama, GPT)","AI auto-assign trade + suggested assignee","AI safety risk scoring (auto-escalate Critical)","Duplicate detection (similarity check on submit)","Voice-to-text input (title, description, search)","Component + issue selector (158 / 296 across 19 groups)","Assign to team member","Cost & time tracking fields","Batch logging mode (same location)"]],
                    ["Review",["Full-text search with highlighting","AI natural language search (voice + text)","Filter by status, severity, entry type","Collapsible filters with clear button","Batch update (Status, Severity, Assignee, Duration, Target Date)","Entry type badges on list & detail (translated)","Detail view with all fields + photos","Update status workflow (5 stages)","Verification photo on Close / Verify","Before / after photo comparison slider","Resolution timeline (visual, color-coded)","Photo comments in timeline","Markup on comment photos (tap to annotate)","Edit own comments inline (with edited indicator)","Quick reactions (thumbs, check, warn, fix)","Delete entry (Admin only)","Telegram alerts on new entry & status change"]],
                    ["Tag on Map",["Action-driven sub-modes in TAG: 🖼 Tag on Drawing · 🗺 Tag on Map · ⇄ Compare Changes","OpenStreetMap as the free default — no API key, no billing, works out of the box","Google Maps as an optional upgrade (satellite + Places search)","Per-project default map view (save current centre/zoom as project home)","Address search: Nominatim on OSM, Places Autocomplete on Google","Tap-to-drop GPS pin → Quick Log creates a defect with lat/lng/zoom","Severity-coloured markers for every map-pinned entry","LIST panel: every pinned entry with tap-to-recenter","Drop-pin toggle — pan freely without accidental pins","Entry detail: static map thumbnail + Open in Google Maps deep link","PDF export: per-entry map thumbnails + ALL PINS ON MAP consolidated page (tile-stitched from OSM — no API key needed, works offline-of-staticmap-services)",
"Consolidated pin overview auto-fits bounds and draws severity-coloured numbered markers (same style as the on-screen LIVE map)","Map markup toolkit: Zone, Radius, Path, Arrow, Dimension (auto-labelled distance), Stamp, Label, Freehand, Photo overlay","All markup types persisted to the map_markups collection per project","Move any markup by dragging the coloured centroid handle (or native drag on Google Maps)","Freehand on Google Maps via transparent canvas overlay","Photo overlay on map — one-click placement with auto bounds; draggable on both providers"]],
                    ["Tag & Compare",["Upload floor plans (JPG, PNG, WEBP, TIF, PDF)","PDF rendering via PDF.js with page navigation","Zoom, pan & pinch-to-zoom (mobile) — works in markup mode too","Center-anchored zoom buttons keep your focal point in place","Zoom / page-nav controls float inside the canvas and never block toolbars","Ring-style defect pins with severity initial","Critical pin pulse animation","Pin tooltip with entry details + remove","Quick-pin: create entry directly from drawing","Defect heatmap overlay (severity-weighted)","Drawing-level markup (freehand, arrows, circles, text)","Drawing notes — pinned text with author + timestamp","Markup color picker + undo / clear","Select arrow icon for select/move tool (matches Figma/Photoshop conventions)","Tap-to-scale ( − / + ) buttons for selected photo markup","Larger photo resize handle with visible corner indicator","Pin count & severity badges on cards","PDF thumbnail preview in list","Diff dropdown: Single (PDFs) and Batch (Folders) in one menu","Single PDF diff with visual overlay of changes","Compare markup — draw on top of the diff (freehand, arrow, circle, text)","Compare markup: select and drag to reposition any stroke","Compare markup: 4 text size presets (S/M/L/XL)","Compare markup: 9-way text alignment via 3x3 grid menu","Compare markup: color picker retargets selected stroke","Compare markup: delete individual strokes without clearing all","Compare markup: overlay site photos onto the diff (capture or pick from device)","Compare markup: drag photos to reposition, +/− to resize, markup on top","AI diff report with lock / approve audit trail","Saved comparisons with overlay thumbnails (markup composited in)","Batch PDFs Comparison (folder vs folder)","Batch completeness check (missing / extra files)","Batch content comparison (per-file diff with detail)","Batch export (CSV + PDF with per-file changes)","Editable set labels (Tender, As-Built, M&E, etc.)"]],
                    ["Dashboard",["Real-time status counts (5 stages)","Critical alerts banner","Severity breakdown chart","Recent entries with type badges","Live sync indicator + queue count"]],
                    ["Admin Analytics",["Entries today / week / month / all time","Active users — who submitted today & this week","Per-user ranking bar chart","Photos stats (total & avg per entry)","Entries by entry type breakdown","Entries by project breakdown","AI usage stats (daily limit, coverage, provider)"]],
                    ["Reports & Exports",["Site report with section-aware tally (defects, drawings, comparisons)","Tally row lays out in a single aligned grid, stays tight on narrow phones","Conditional severity / status / assignee breakdowns","Filter by severity / status / assignee / date","Email content sections (defects, drawings, comparisons)","Email preview with opt-in/out per section — includes pin entries from drawings","Translated email reports (all values in user's language)","Email report via PocketBase SMTP","Contract Advisor — AI clause-to-defect mapping (PSSCOC/REDAS/SIA)","Google Sheets export (new tab per export)","EXPORT all-in-one CSV (defects + annotations + comparisons)","Dn menu: Markup CSV / PDF export","Dn menu: Compare CSV / PDF export","Dn menu: All CSV / PDF export","Dn menu: All-in-One (CSV + PDF in one tap)","Annotated drawings embedded in PDF exports (pins, notes, markup burned in)",
"GPS-tag map thumbnails + consolidated pin overview embedded in PDF exports (reliable OSM tile-stitch fallback when no Google key)","Pins render in their severity colors regardless of section toggles","Live progress feedback during PDF export (Preparing → Rendering drawing N/M → Saving)","Per-drawing PDF export from the viewer"]],
                    ["Multi-Language (i18n)",["22 languages (EN, ZH, ZH-TW, MS, ID, HI, TA, TH, VI, BN, JA, KO, DE, FR, ES, PT, IT, TR, SV, NO, DA, FI)","Full UI translation (617 keys — labels, buttons, placeholders, errors)","Dropdown option translation (539 terms — components, issues, levels, zones, durations, costs)","Construction industry terminology per language","Language selector with flags + native names","Instant English (inlined) + lazy-loaded language packs","Fallback chain: language → English → raw key"]],
                    ["Storage",["PocketBase (default server)","Local path (self-hosted server / machine)","Google Drive (OAuth, personal cloud)"]],
                    ["Setup & Integrations",["Single Settings dropdown for all one-time setup","AI multi-provider setup + test (Gemini, Ollama, OpenAI)","Telegram bot setup + test","Storage mode selector (PocketBase, local path, Google Drive)","Language selector (22 languages)","Daily AI usage limit","Email report config (inside Report tab)","Green ✓ check per configured integration"]],
                    ["Offline",["Save entries to IndexedDB when offline","Queued badge in header + Dashboard","Auto-sync when back online","Manual sync tap","Queued / synced status indicator"]],
                    ["Account",["Edit display name + job title","Change email","Change password"]],
                    ["Other",["Comprehensive help guide","Feedback form (suggestion, bug, praise)","Cached app shell (service worker)","Photo compression (auto-resize)","Hover-to-open dropdowns (desktop) + tap-to-open (mobile)"]],
                  ];const total=fc.reduce((n,c)=>n+c[1].length,0);return React.createElement(React.Fragment,null,
                    React.createElement("div",{style:{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:12,padding:16,marginBottom:20,textAlign:"center"}},
                      React.createElement("div",{style:{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#30d158",lineHeight:1,marginBottom:4}},total),
                      React.createElement("div",{style:{fontSize:11,color:"rgba(255,255,255,0.4)"}},"features")
                    ),
                    fc.map(function(c){var cat=c[0],items=c[1];return React.createElement("div",{key:cat,style:{marginBottom:18}},
                      React.createElement("div",{style:{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"#ff6b00",letterSpacing:"0.08em",marginBottom:6,display:"flex",justifyContent:"space-between"}},
                        React.createElement("span",null,cat.toUpperCase()),
                        React.createElement("span",{style:{color:"rgba(255,255,255,0.3)",fontWeight:600}},items.length)
                      ),
                      items.map(function(feat,i){return React.createElement("div",{key:i,style:{display:"flex",gap:8,alignItems:"center",padding:"3px 0",fontSize:12,color:"rgba(255,255,255,0.5)"}},
                        React.createElement("span",{style:{fontSize:10,color:"#30d158",flexShrink:0}},"✓"),
                        React.createElement("span",null,feat)
                      );})
                    );})
                  );})()}
                </div>
              )}

              <div style={{textAlign:"center",marginTop:20}}>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.2)",fontFamily:"'Barlow Condensed',sans-serif"}}>SiteShrimp v2.1 — Built for teams that deliver</div>
                <button onClick={()=>setShowHelp(false)} style={{marginTop:16,background:"#ff6b00",border:"none",borderRadius:10,padding:"12px 32px",color:"#fff",fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>{t("actions.ok")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showFeedback&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:24,width:"100%",maxWidth:400,animation:"fadeIn 0.15s ease"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#fff",marginBottom:4}}>{t("feedback.title").toUpperCase()}</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:20,lineHeight:1.5}}>Help us improve SiteShrimp! Share your thoughts on the design, usability, or features. What works well? What feels confusing? Any ideas for improvement?</div>
            {fbSent?(
              <div style={{textAlign:"center",padding:"20px 0"}}>
                <div style={{fontSize:28,marginBottom:10}}>✓</div>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:700,color:"#00e564",marginBottom:6}}>THANK YOU!</div>
                <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:20}}>Your feedback has been recorded. We read every submission.</div>
                <button onClick={()=>setShowFeedback(false)} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"12px 32px",color:"#fff",fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>{t("actions.done")}</button>
              </div>
            ):(
              <>
                <div style={{display:"flex",gap:6,marginBottom:14}}>
                  {[["suggestion",t("feedback.suggestion")],["bug",t("feedback.bug_report")],["praise",t("feedback.what_i_like")],["other","Other"]].map(([id,label])=>(
                    <button key={id} onClick={()=>setFbType(id)} style={{flex:1,padding:"8px 4px",borderRadius:8,border:`1.5px solid ${fbType===id?"#ff6b00":"rgba(255,255,255,0.1)"}`,background:fbType===id?"rgba(255,107,0,0.15)":"rgba(255,255,255,0.05)",color:fbType===id?"#ff6b00":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{label}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:16}}>
                  <textarea value={fbText} onChange={e=>setFbText(e.target.value)} placeholder={t("feedback.placeholder")} rows={4} style={{flex:1,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"12px",color:"#fff",fontSize:14,resize:"none",fontFamily:"'Barlow',sans-serif"}}/>
                  <MicBtn onResult={t=>setFbText(t)} append={true} currentValue={fbText}/>
                </div>
                <button onClick={async()=>{
                  if(!fbText.trim())return;
                  setFbSending(true);
                  try{
                    await DB.activity.create({companyId:company?.companyId||"none",type:"feedback",feedbackType:fbType,text:fbText.trim(),userId:authUser?.id,userEmail:authUser?.email,userName:member?.name||"",createdAt:new Date().toISOString()});
                    setFbSent(true);
                  }catch(e){console.warn("Feedback save failed:",e);}
                  setFbSending(false);
                }} disabled={fbSending||!fbText.trim()} style={{width:"100%",background:fbText.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"14px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",opacity:fbSending?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  {fbSending?<Spin size={16}/>:null}{fbSending?t("messages.sending"):t("actions.submit_feedback")}
                </button>
                <button onClick={()=>setShowFeedback(false)} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:12,cursor:"pointer",padding:"12px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>{t("actions.cancel")}</button>
              </>
            )}
          </div>
        </div>
      )}
      {showTg&&<TelegramSettings onClose={()=>setShowTg(false)} companyId={company?.companyId}/>}
      {showEmail&&<EmailSettings onClose={()=>setShowEmail(false)} companyId={company?.companyId}/>}
      {showGemini&&<GeminiSettings onClose={()=>setShowGemini(false)} companyId={company?.companyId}/>}
      {showStorage&&<StorageSettings onClose={()=>setShowStorage(false)} companyId={company?.companyId}/>}
      {showMaps&&<MapsSettings onClose={()=>setShowMaps(false)}/>}
      {showUsers&&<UserManagement onClose={()=>setShowUsers(false)} company={company} member={member} members={members}/>}
      {showAdminAnalytics&&isAdmin&&(
        <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:300,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
          <SettingsBack onClose={()=>setShowAdminAnalytics(false)} title={t("dashboard.admin_analytics")}/>
          <AdminAnalytics defects={defects} members={members} company={company} currentProject={currentProject} projects={projects}/>
        </div>
      )}
      {showProjects&&<ProjectManagement onClose={()=>setShowProjects(false)} company={company} member={member} projects={projects} currentProject={currentProject} onSelect={p=>{selectProject(p);setShowProjects(false);}}/>}
      {/* Language Picker */}
      {showLangPicker&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"#1a1a1a",overflowY:"auto",animation:"slideUp 0.25s ease"}}>
          <div style={{maxWidth:430,margin:"0 auto"}}>
            <SettingsBack onClose={()=>setShowLangPicker(false)} title={t("language.title")}/>
            <div style={{padding:"16px"}}>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.1em",marginBottom:12}}>{t("language.select").toUpperCase()}</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {languages.map(l=>(
                  <button key={l.code} onClick={()=>{setLang(l.code);setShowLangPicker(false);}} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:lang===l.code?"rgba(255,107,0,0.12)":"rgba(255,255,255,0.04)",border:lang===l.code?"1px solid rgba(255,107,0,0.4)":"1px solid rgba(255,255,255,0.08)",borderRadius:10,cursor:"pointer",textAlign:"left"}}>
                    <span style={{fontSize:22}}>{l.flag}</span>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,color:lang===l.code?"#ff6b00":"#fff"}}>{l.name}</div>
                      <div style={{fontSize:11,color:"rgba(255,255,255,0.35)",marginTop:1}}>{l.code}</div>
                    </div>
                    {lang===l.code&&<span style={{color:"#ff6b00",fontSize:16,fontWeight:800}}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

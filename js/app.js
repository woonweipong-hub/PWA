// SiteShrimp v2 — Multi-tenant Construction Site Tracker
// Features: Auth, Companies, Projects, Roles, AI, Telegram, Email
// Constants loaded from js/constants.js (SEVERITY, STATUS, ROLES, ENTRY_TYPES, etc.)
const {useState,useEffect,useRef,useCallback}=React;

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
const BCA_SCDF_REVISION_COLORS={added:"#ff3b30",removed:"#34c759"};
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
      [...rows.entries()].sort((a,b)=>b[0]-a[0]).forEach(([,items])=>{
        const line=normalizePdfLine(items.sort((a,b)=>a.x-b.x).map(i=>i.txt).join(" "));
        if(line.length>2)lines.push(`P${pageNum} ${line}`);
      });
    }
    return lines;
  }finally{
    try{await doc.destroy();}catch{}
  }
}

function comparePdfLineSets(baseLines,revisionLines){
  const baseSet=new Set(baseLines);
  const revisionSet=new Set(revisionLines);
  const added=revisionLines.filter(l=>!baseSet.has(l));
  const removed=baseLines.filter(l=>!revisionSet.has(l));
  return{added,removed};
}

// ── Photo Markup Editor ──────────────────────────────────────────
function PhotoMarkup({src,onSave,onCancel}){
  const canvasRef=useRef();const overlayRef=useRef();
  const[tool,setTool]=useState("arrow"); // arrow, circle, freehand, text
  const[color,setColor]=useState("#ff3b30");
  const[strokes,setStrokes]=useState([]);
  const[current,setCurrent]=useState(null);
  const[imgLoaded,setImgLoaded]=useState(false);
  const[textInput,setTextInput]=useState(null);
  const imgRef=useRef(new Image());
  const sizeRef=useRef({w:0,h:0});

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
  },[imgLoaded,strokes,current]);

  const drawStroke=(ctx,s)=>{
    ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.lineWidth=3;ctx.lineCap="round";ctx.lineJoin="round";
    if(s.type==="freehand"&&s.points.length>1){
      ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i].x,s.points[i].y);
      ctx.stroke();
    }else if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y;
      const len=Math.sqrt(dx*dx+dy*dy);
      if(len<5)return;
      ctx.beginPath();ctx.moveTo(s.start.x,s.start.y);ctx.lineTo(s.end.x,s.end.y);ctx.stroke();
      // Arrowhead
      const angle=Math.atan2(dy,dx);const hl=14;
      ctx.beginPath();
      ctx.moveTo(s.end.x,s.end.y);
      ctx.lineTo(s.end.x-hl*Math.cos(angle-0.4),s.end.y-hl*Math.sin(angle-0.4));
      ctx.moveTo(s.end.x,s.end.y);
      ctx.lineTo(s.end.x-hl*Math.cos(angle+0.4),s.end.y-hl*Math.sin(angle+0.4));
      ctx.stroke();
    }else if(s.type==="circle"&&s.start&&s.end){
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      const cx=Math.min(s.start.x,s.end.x)+rx,cy=Math.min(s.start.y,s.end.y)+ry;
      if(rx<3&&ry<3)return;
      ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.stroke();
    }else if(s.type==="text"&&s.pos&&s.text){
      ctx.font="bold 16px 'Barlow Condensed',sans-serif";
      ctx.fillStyle=s.color;
      // Background
      const metrics=ctx.measureText(s.text);
      ctx.fillStyle="rgba(0,0,0,0.6)";
      ctx.fillRect(s.pos.x-2,s.pos.y-16,metrics.width+8,22);
      ctx.fillStyle=s.color;
      ctx.fillText(s.text,s.pos.x+2,s.pos.y);
    }
  };

  const getPos=e=>{
    const rect=canvasRef.current.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{x:t.clientX-rect.left,y:t.clientY-rect.top};
  };

  const onDown=e=>{
    e.preventDefault();
    if(tool==="text"){setTextInput(getPos(e));return;}
    const p=getPos(e);
    if(tool==="freehand")setCurrent({type:"freehand",color,points:[p]});
    else setCurrent({type:tool,color,start:p,end:p});
  };
  const onMove=e=>{
    if(!current)return;
    e.preventDefault();
    const p=getPos(e);
    if(current.type==="freehand")setCurrent(c=>({...c,points:[...c.points,p]}));
    else setCurrent(c=>({...c,end:p}));
  };
  const onUp=()=>{
    if(current){setStrokes(s=>[...s,current]);setCurrent(null);}
  };

  const submitText=(text)=>{
    if(text&&textInput){
      setStrokes(s=>[...s,{type:"text",color,pos:textInput,text}]);
    }
    setTextInput(null);
  };

  const undo=()=>setStrokes(s=>s.slice(0,-1));

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
      if(s.type==="freehand")return{...s,points:s.points.map(p=>({x:p.x*sx,y:p.y*sy}))};
      if(s.type==="text")return{...s,pos:{x:s.pos.x*sx,y:s.pos.y*sy}};
      return{...s,start:{x:s.start.x*sx,y:s.start.y*sy},end:{x:s.end.x*sx,y:s.end.y*sy}};
    };
    fctx.lineWidth=3*sx;fctx.lineCap="round";fctx.lineJoin="round";
    strokes.forEach(s=>{
      const scaled=scaleStroke(s);
      // Scale font for text
      if(scaled.type==="text"){
        fctx.font=`bold ${Math.round(16*sx)}px 'Barlow Condensed',sans-serif`;
      }
      drawStroke(fctx,scaled);
    });
    onSave(fc.toDataURL("image/jpeg",0.92));
  };

  const TOOLS=[
    {id:"arrow",label:"↗",title:"Arrow"},
    {id:"circle",label:"○",title:"Circle"},
    {id:"freehand",label:"✏",title:"Draw"},
    {id:"text",label:"T",title:"Text"}
  ];
  const COLORS=["#ff3b30","#ff9500","#ffcc00","#fff"];

  return(
    <div style={{position:"fixed",inset:0,background:"#1a1a1a",zIndex:300,display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
        <button onClick={onCancel} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>CANCEL</button>
        <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",textAlign:"center"}}>MARKUP PHOTO</div>
        <button onClick={save} style={{background:"#ff6b00",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>SAVE</button>
      </div>

      {/* Toolbar */}
      <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
        {TOOLS.map(t=>(
          <button key={t.id} onClick={()=>setTool(t.id)} title={t.title} style={{width:40,height:40,borderRadius:10,border:tool===t.id?"2px solid #ff6b00":"2px solid rgba(255,255,255,0.15)",background:tool===t.id?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{t.label}</button>
        ))}
        <div style={{width:1,height:28,background:"rgba(255,255,255,0.15)",margin:"0 4px"}}/>
        {COLORS.map(c=>(
          <button key={c} onClick={()=>setColor(c)} style={{width:28,height:28,borderRadius:"50%",border:color===c?"3px solid #fff":"3px solid rgba(255,255,255,0.15)",background:c,cursor:"pointer"}}/>
        ))}
        <div style={{flex:1}}/>
        <button onClick={undo} disabled={strokes.length===0} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"7px 12px",color:strokes.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>UNDO</button>
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
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:12}}>ADD TEXT ANNOTATION</div>
            <input autoFocus type="text" placeholder="Type annotation..." onKeyDown={e=>{if(e.key==="Enter")submitText(e.target.value);}}
              style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.05)",color:"#fff",fontSize:14,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>setTextInput(null)} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>CANCEL</button>
              <button onClick={e=>{const inp=e.target.closest("div").parentElement.querySelector("input");submitText(inp.value);}} style={{flex:1,padding:10,borderRadius:10,border:"none",background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>ADD</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AI_PROMPT='Analyze this construction defect photo. Respond in valid JSON only, no markdown: {"title":"max 5 word defect title","severity":"one of Critical Major Minor Observation","description":"2 sentence technical description","trade":"responsible trade e.g. Plumbing Electrical Waterproofing Painting Tiling Structural Carpentry Aircon General","safety_risk":1 to 5 integer where 5 is life-threatening hazard and 1 is cosmetic,"suggested_assignee":"trade role to assign e.g. Plumber Electrician Painter Tiler Contractor"}';

async function analyzeWithGemini(apiKey,base64Image){
  try{
    const b64=base64Image.split(",")[1];
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[
        {inline_data:{mime_type:"image/jpeg",data:b64}},
        {text:AI_PROMPT}
      ]}]})
    });
    const data=await res.json();
    const text=data.candidates?.[0]?.content?.parts?.[0]?.text||"{}";
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
      const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})
      });
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

function isAiConfigured(){
  const provider=local.get(AI_PROVIDER_KEY)||"gemini";
  if(provider==="gemini")return !!local.get(GEMINI_KEY);
  if(provider==="ollama"){const c=local.get(OLLAMA_KEY);return !!(c&&c.url);}
  if(provider==="openai"){const c=local.get(OPENAI_KEY);return !!(c&&c.apiKey);}
  return false;
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

function generateEmailHTML(defects,projectName,companyName){
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
  const typeSummary=Object.entries(typeCounts).map(([t,c])=>`<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:bold;color:${typeColor(t)};background:${typeBg(t)}">${typeIcon(t)} ${t} (${c})</span>`).join("");

  const row=(label,val)=>val?`<tr><td style="padding:2px 8px 2px 0;color:#999;white-space:nowrap;vertical-align:top">${label}</td><td>${val}</td></tr>`:"";

  const defectRows=defects.map(d=>{
    const dt=(d.createdAt||d.created)?new Date(d.createdAt||d.created).toLocaleDateString("en-GB"):"—";
    const entryTypeBadge=d.entryType?`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${typeColor(d.entryType)};background:${typeBg(d.entryType)};margin-right:6px">${typeIcon(d.entryType)} ${d.entryType}</span>`:"";
    const sevBadge=`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${SEV_COLOR[d.severity]};background:${SEV_BG[d.severity]}">${d.severity}</span>`;
    const statusBadge=`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:bold;color:${STATUS_COLOR[d.status]||"#8e8e93"};background:rgba(0,0,0,0.06)">${d.status}</span>`;
    const comments=(d.comments||[]).map(c=>`<div style="padding:6px 10px;background:#f5f5f5;border-radius:6px;font-size:12px;margin:4px 0"><b style="color:#ff6b00">${sanitize(c.by)}:</b> ${sanitize(c.text)}</div>`).join("");
    const photoNote=d.photo?`<div style="font-size:11px;color:#888;font-style:italic;margin-top:6px;padding:6px 8px;background:#f5f5f5;border-radius:6px">📷 ${Array.isArray(d.photo)?d.photo.length:1} photo(s) — view in SiteShrimp app</div>`:"";

    return `<div style="margin-bottom:14px;padding:14px;border:1px solid #e5e5e5;border-radius:10px;border-left:5px solid ${SEV_COLOR[d.severity]}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">${entryTypeBadge}${sevBadge}${statusBadge}${d.defect_id?`<span style="font-size:10px;color:#aaa;margin-left:auto">${d.defect_id}</span>`:""}</div>
      <div style="font-size:15px;font-weight:bold;margin-bottom:8px">${sanitize(d.title)||"—"}</div>
      <table style="font-size:12px;color:#555;margin-bottom:6px"><tbody>
        ${row("📍 Location",d.location)}
        ${row("👤 Assigned",d.assignee)}
        ${row("🔧 Component",d.component?(d.component+(d.issue?" — "+d.issue:"")):"") }
        ${row("🏗 Trade",d.trade)}
        ${row("✍️ By",d.loggedBy?(d.loggedBy+(d.loggedByRole?" ("+d.loggedByRole+")":"")):"") }
        ${row("📅 Date",dt)}
        ${row("⏰ Due",d.dueDate)}
        ${row("⏱ Duration",d.duration)}
        ${row("💰 Cost",d.costImpact?(d.costImpact+(d.costAmount?" — $"+d.costAmount:"")):"") }
        ${row("📋 Responsible",d.costResponsible)}
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
    <div style="text-align:center;color:#aaa;font-size:11px;padding:12px">SiteShrimp v2 · ${date}</div>
  </body></html>`;
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

const SevChip=({s})=><span style={{display:"inline-flex",alignItems:"center",padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",color:SEV_COLOR[s],background:SEV_BG[s]}}>{s.toUpperCase()}</span>;
const StatusChip=({s})=><span style={{display:"inline-flex",alignItems:"center",padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",color:STATUS_COLOR[s],background:STATUS_COLOR[s]+"22"}}>{s.toUpperCase()}</span>;
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

// ComboField: dropdown with predefined options + free text input
// For foreign workers: tap to select. For architects: type custom value.
function ComboField({label,value,onChange,options,placeholder,grouped}){
  const[custom,setCustom]=useState(false);
  const[search,setSearch]=useState("");
  const allOpts=grouped?Object.values(grouped).flat():options||[];
  const isCustom=custom||(!allOpts.includes(value)&&value);

  if(isCustom)return(
    <div style={{marginBottom:16}}>
      <label style={lbl()}>{label}</label>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder||"Type here..."} style={{...inp,flex:1}}/>
        <MicBtn onResult={t=>onChange(t)} currentValue={value}/>
        <button onClick={()=>{setCustom(false);setSearch("");}} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:8,padding:"8px 10px",fontSize:11,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,flexShrink:0}}>LIST</button>
      </div>
    </div>
  );

  // Grouped options (e.g. COMPONENT_GROUPS)
  if(grouped){
    const groups=grouped;
    const filteredGroups=search
      ?Object.fromEntries(Object.entries(groups).map(([g,items])=>[g,items.filter(it=>it.toLowerCase().includes(search.toLowerCase()))]).filter(([,items])=>items.length>0))
      :groups;
    return(
      <div style={{marginBottom:16}}>
        <label style={lbl()}>{label}</label>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..." style={{...inp,flex:1,fontSize:13}}/>
          <MicBtn onResult={t=>setSearch(t)} currentValue={search}/>
          <button onClick={()=>setCustom(true)} style={{background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:8,padding:"8px 10px",fontSize:11,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"#ff6b00",flexShrink:0}}>TYPE</button>
        </div>
        <div style={{maxHeight:200,overflowY:"auto",borderRadius:10,border:"1px solid rgba(0,0,0,0.08)"}}>
          {Object.entries(filteredGroups).map(([group,items])=>(
            <div key={group}>
              <div style={{padding:"6px 12px",background:"rgba(0,0,0,0.04)",fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em",position:"sticky",top:0}}>{group.toUpperCase()}</div>
              {items.map(it=>(
                <div key={it} onClick={()=>{if(it==="Other"||it==="General"){setCustom(true);onChange("");}else{onChange(it);}setSearch("");}} style={{padding:"10px 12px",cursor:"pointer",background:value===it?"rgba(255,107,0,0.08)":"#fff",borderBottom:"1px solid rgba(0,0,0,0.04)",fontSize:14,color:value===it?"#ff6b00":"#1a1a1a",fontWeight:value===it?700:400}}>
                  {it}
                </div>
              ))}
            </div>
          ))}
          {Object.keys(filteredGroups).length===0&&<div style={{padding:16,textAlign:"center",color:"rgba(0,0,0,0.3)",fontSize:13}}>No match</div>}
        </div>
      </div>
    );
  }

  // Flat options list with chip-style buttons
  return(
    <div style={{marginBottom:16}}>
      <label style={lbl()}>{label}</label>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
        {options.map(opt=>(
          <button key={opt} onClick={()=>{if(opt==="Other"||opt==="General"){setCustom(true);onChange("");}else onChange(opt);}} style={{padding:"8px 12px",borderRadius:20,border:`1.5px solid ${value===opt?"#ff6b00":"rgba(0,0,0,0.12)"}`,background:value===opt?"rgba(255,107,0,0.08)":"#fff",color:value===opt?"#ff6b00":"rgba(0,0,0,0.6)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,fontSize:12,cursor:"pointer"}}>{opt}</button>
        ))}
      </div>
      <button onClick={()=>setCustom(true)} style={{background:"none",border:"none",fontSize:11,color:"rgba(255,107,0,0.7)",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,padding:"4px 0"}}>+ Type custom value</button>
    </div>
  );
}

function SettingsBack({onClose,title}){
  return(
    <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12}}>
      <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
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
  const[url,setUrl]=useState(()=>localStorage.getItem('pb_url')||'https://siteshrimp.duckdns.org');
  const[saved,setSaved]=useState(false);
  const apply=()=>{
    const cleaned=url.trim().replace(/\/+$/,'');
    if(!cleaned)return;
    localStorage.setItem('pb_url',cleaned);
    setSaved(true);
    setTimeout(()=>window.location.reload(),800);
  };
  return(
    <div style={{marginTop:16}}>
      <button onClick={()=>setOpen(o=>!o)} style={{background:'none',border:'none',color:'rgba(255,255,255,0.25)',fontSize:12,cursor:'pointer',width:'100%',textAlign:'center',fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:'0.06em',padding:'4px 0'}}>
        ⚙ {open?'HIDE':'SERVER URL'}
      </button>
      {open&&(
        <div style={{marginTop:8,padding:'12px 14px',background:'rgba(255,255,255,0.05)',borderRadius:10,border:'1px solid rgba(255,255,255,0.1)'}}>
          <label style={lbl('rgba(255,255,255,0.4)')}>POCKETBASE URL</label>
          <div style={{display:'flex',gap:8}}>
            <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://your-server.example.com" style={{...darkInp,flex:1,fontSize:13,padding:'9px 12px'}}/>
            <button onClick={apply} style={{background:'#ff6b00',border:'none',borderRadius:8,padding:'0 14px',color:'#fff',fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:'pointer',flexShrink:0}}>
              {saved?'✓':'SET'}
            </button>
          </div>
          <div style={{fontSize:11,color:'rgba(255,255,255,0.2)',marginTop:6}}>Changing URL will reload the app.</div>
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
  const[viewportH,setViewportH]=useState(window.innerHeight||800);
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
            Manage defects, inspections, progress, and records.
          </div>
          <div style={{color:"rgba(255,255,255,0.42)",fontSize:introPreset.body,marginBottom:introPreset.textGap,lineHeight:introPreset.lineH}}>
            Capture issues with photos, voice, and drawings. Turn messy data into clean records and reports for faster closure.
          </div>

          <div style={{textAlign:"left",marginBottom:introPreset.textGap}}>
          {[
            ["📷","Log faster with AI","Snap photos and auto-fill issue details in seconds."],
            ["📐","See issues on drawings","Pin and track issues directly on floor plans."],
            ["🎤","Work hands-free","Use voice to log, fill fields, and search quickly."],
            ["📋","Clear audit trail","Track updates with verification and before/after proof."],
            ["👥","Coordinate your team","Assign tasks with live sync and instant alerts."],
            ["📊","Report without rework","Export CSV and share polished reports fast."],
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
        <div>
          <button onClick={()=>setPage("auth")} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:11,padding:introPreset.btnPad,color:"#fff",fontSize:introPreset.btnFont,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:8,letterSpacing:"0.04em"}}>GET STARTED</button>

          <button onClick={installable?installApp:()=>alert("To install:\n\nAndroid: Menu (⋮) → Add to Home Screen\n\niPhone: Share (↑) → Add to Home Screen")} style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:11,padding:introPreset.btnPad,color:"rgba(255,255,255,0.82)",fontSize:introPreset.btnFont,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:9,display:"flex",alignItems:"center",justifyContent:"center",gap:introPreset.btnGap}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="rgba(255,255,255,0.82)" strokeWidth="2" strokeLinecap="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="rgba(255,255,255,0.82)" strokeWidth="2" strokeLinecap="round"/></svg>
            INSTALL APP
          </button>

          <div style={{color:"rgba(255,255,255,0.62)",fontSize:introPreset.footer,fontFamily:"'Barlow Condensed',sans-serif"}}>
            Free for all Users.
          </div>
        </div>
      </div>
    </div>
  );

  // ── Login / Register page (consolidated) ──
  return(
    <div style={{minHeight:"100dvh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:"18px 16px",overflowY:"auto"}}>
      <div style={{width:"100%",maxWidth:420}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={()=>setPage("intro")} style={{background:"rgba(255,255,255,0.07)",border:"none",borderRadius:20,padding:"6px 12px",color:"rgba(255,255,255,0.5)",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>←</button>
          <div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:31,fontWeight:800,color:"#fff",lineHeight:1}}>SITESHRIMP</div>
            <div style={{color:"rgba(255,255,255,0.45)",fontSize:13}}>Construction Site Tracker</div>
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
      <SettingsBack onClose={onClose} title="👥 TEAM MANAGEMENT"/>
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
      <SettingsBack onClose={onClose} title="📁 PROJECTS"/>
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
  if(["telegram","gemini","email"].includes(key))return;
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
      if(key==="telegram"||key==="gemini"||key==="email")return;
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
      <SettingsBack onClose={onClose} title="TELEGRAM SETUP"/>
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
        const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gemKey.trim()}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:"Reply with just: OK"}]}]})});
        setTestRes(res.ok?"success":"fail");
      }else if(provider==="ollama"){
        const url=ollamaUrl.trim().replace(/\/+$/,"");
        const res=await fetch(url+"/api/tags");
        if(res.ok){
          const d=await res.json();
          const models=(d.models||[]).map(m=>m.name);
          setOllamaModels(models);
          setTestRes(models.length>0?"success":"fail");
        }else{setTestRes("fail");}
      }else if(provider==="openai"){
        const url=oaiUrl.trim().replace(/\/+$/,"");
        const res=await fetch(url+"/v1/models",{headers:{"Authorization":"Bearer "+oaiKey.trim()}});
        setTestRes(res.ok?"success":"fail");
      }
    }catch{setTestRes("fail");}
    setTesting(false);
  };

  const canTest=provider==="gemini"?!!gemKey:provider==="ollama"?!!ollamaUrl:!!(oaiKey&&oaiUrl);

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title="AI PHOTO ANALYSIS"/>
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
            {[["1","Go to aistudio.google.com and sign in with Google"],["2","Click Get API Key → Create API Key"],["3","Copy the key and paste below → Test → Save"]].map(([n,t])=>(
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
        {testRes&&<div style={{background:testRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${testRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:16,color:testRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>{testRes==="success"?"✓ AI connected! Photos will be auto-analyzed.":"✗ Connection failed. Check your settings and try again."}</div>}
        <div style={{display:"flex",gap:10}}>
          <button onClick={test} disabled={!canTest||testing} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:13,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{testing?"TESTING...":"TEST"}</button>
          <button onClick={save} disabled={!canTest} style={{flex:2,background:canTest?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:13,color:canTest?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Email Settings ────────────────────────────────────────────────
function EmailSettings({onClose,companyId}){
  const s=local.get(EMAIL_KEY)||{publicKey:"",serviceId:"",templateId:"",recipients:[""]};
  const[pk,setPk]=useState(s.publicKey);const[sid,setSid]=useState(s.serviceId);
  const[tid,setTid]=useState(s.templateId);const[rec,setRec]=useState(s.recipients.length?s.recipients:[""]);
  const[saved,setSaved]=useState(false);
  const save=()=>{const cfg={publicKey:pk.trim(),serviceId:sid.trim(),templateId:tid.trim(),recipients:rec.filter(r=>r.trim())};local.set(EMAIL_KEY,cfg);saveSettingToFirestore(companyId,"email",cfg);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title="📧 EMAIL REPORTS"/>
      <div style={{padding:20}}>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
          {[["1","Go to emailjs.com → Sign up free"],["2","Add Email Service (Gmail/Outlook) → copy Service ID"],["3","Create Template → set HTML body to {{{html_content}}} → copy Template ID"],["4","Account → copy Public Key → paste all below → Save"]].map(([n,t])=>(
            <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
              <div style={{width:22,height:22,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
              <div style={{fontSize:13,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
            </div>
          ))}
        </div>
        <div style={{marginBottom:12}}><label style={lbl()}>PUBLIC KEY</label><input value={pk} onChange={e=>setPk(e.target.value)} placeholder="user_XXXXXXXX" style={{...inp,width:"100%",flex:"unset"}}/></div>
        <div style={{marginBottom:12}}><label style={lbl()}>SERVICE ID</label><input value={sid} onChange={e=>setSid(e.target.value)} placeholder="service_XXXXXX" style={{...inp,width:"100%",flex:"unset"}}/></div>
        <div style={{marginBottom:16}}><label style={lbl()}>TEMPLATE ID</label><input value={tid} onChange={e=>setTid(e.target.value)} placeholder="template_XXXXXX" style={{...inp,width:"100%",flex:"unset"}}/></div>
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
        <button onClick={save} disabled={!pk||!sid||!tid} style={{width:"100%",background:pk&&sid&&tid?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:14,color:pk&&sid&&tid?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
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
      const pbUrl=localStorage.getItem('pb_url')||'https://siteshrimp.duckdns.org';
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
      <SettingsBack onClose={onClose} title="STORAGE SETTINGS"/>
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

        {/* Save button */}
        <button onClick={save} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:14,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE SETTINGS"}</button>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────
function Dashboard({defects,onView,tgEnabled,aiEnabled,syncing,company,currentProject,member,onDrawings,queueCount,onSyncQueue,syncing2}){
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
            :<div style={{display:"flex",alignItems:"center",gap:4,background:"rgba(0,229,100,0.1)",border:"1px solid rgba(0,229,100,0.2)",borderRadius:20,padding:"4px 8px"}}><div style={{width:6,height:6,borderRadius:"50%",background:"#00e564",animation:"pulse 2s infinite"}}/><span style={{fontSize:10,fontWeight:700,color:"#00e564",fontFamily:"'Barlow Condensed',sans-serif"}}>LIVE</span></div>
          }
          {tgEnabled&&<div style={{background:"rgba(0,136,204,0.1)",border:"1px solid rgba(0,136,204,0.25)",borderRadius:20,padding:"4px 8px"}}><span style={{fontSize:10,fontWeight:700,color:"#0088cc",fontFamily:"'Barlow Condensed',sans-serif"}}>TG</span></div>}
          {aiEnabled&&<div style={{background:"rgba(88,86,214,0.1)",border:"1px solid rgba(88,86,214,0.25)",borderRadius:20,padding:"4px 8px"}}><span style={{fontSize:10,fontWeight:700,color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif"}}>AI</span></div>}
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <Card label="OPEN" value={open} color="#ff3b30"/>
        <Card label="IN PROG" value={inprog} color="#ff9500"/>
        <Card label="DONE" value={done} color="#34aadc"/>
        <Card label="VERIFIED" value={verified} color="#30d158"/>
        <Card label="CLOSED" value={closed} color="#8e8e93"/>
      </div>

      {critical>0&&(
        <div style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.25)",borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:20}}>⚠️</div>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"#ff3b30",fontSize:14}}>{critical} CRITICAL UNRESOLVED</div><div style={{fontSize:12,color:"rgba(0,0,0,0.5)"}}>Requires immediate attention</div></div>
        </div>
      )}

      {queueCount>0&&(
        <button onClick={onSyncQueue} style={{width:"100%",background:"rgba(255,149,0,0.1)",border:"1px solid rgba(255,149,0,0.25)",borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left"}}>
          {syncing2?<Spin size={16}/>:<span style={{fontSize:20}}>📤</span>}
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,color:"#ff9500",fontSize:14}}>{queueCount} QUEUED OFFLINE</div>
            <div style={{fontSize:12,color:"rgba(0,0,0,0.5)"}}>{syncing2?"Syncing now...":navigator.onLine?"Tap to sync now":"Will auto-sync when online"}</div>
          </div>
        </button>
      )}

      {sevData.length>0&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:16}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:12}}>BY SEVERITY</div>
          {sevData.map(({s,count})=>(
            <div key={s} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:SEV_COLOR[s]}}>{s.toUpperCase()}</span>
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12}}>{count}</span>
              </div>
              <div style={{background:"rgba(0,0,0,0.06)",borderRadius:4,height:5,overflow:"hidden"}}>
                <div style={{background:SEV_COLOR[s],height:"100%",width:defects.length?`${(count/defects.length)*100}%`:"0%",borderRadius:4,transition:"width 0.5s ease"}}/>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drawings shortcut */}
      <button onClick={onDrawings} style={{width:"100%",background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:14,padding:"14px 16px",marginBottom:16,cursor:"pointer",display:"flex",alignItems:"center",gap:12,textAlign:"left"}}>
        <span style={{fontSize:24}}>📐</span>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,color:"#1a1a1a"}}>FLOOR PLANS & DRAWINGS</span><span style={{fontSize:9,fontWeight:700,color:"#ff9500",background:"rgba(255,149,0,0.12)",border:"1px solid rgba(255,149,0,0.25)",borderRadius:10,padding:"2px 6px",fontFamily:"'Barlow Condensed',sans-serif"}}>BETA</span></div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>Upload drawings, tap to place defect pins</div>
        </div>
        <span style={{color:"rgba(0,0,0,0.2)",fontSize:14}}>→</span>
      </button>

      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:10}}>RECENT ENTRIES</div>
      {defects.length===0&&(
        <div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"40px 0",fontSize:14}}>
          No defects yet.{["Admin","Manager","Inspector"].includes(member?.role)?" Tap + Log to start.":""}
        </div>
      )}
      {defects.slice(0,6).map((d,i)=>(
        <div key={d.id} onClick={()=>onView(d)} className="anim" style={{animationDelay:`${i*0.05}s`,background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",borderLeft:`4px solid ${SEV_COLOR[d.severity]}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,color:"#1a1a1a",flex:1,paddingRight:8}}>{d.title}</div>
            <StatusChip s={d.status}/>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {d.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(d.entryType),background:typeBg(d.entryType),padding:"2px 8px",borderRadius:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(d.entryType)} {d.entryType.toUpperCase()}</span>}
            <SevChip s={d.severity}/>
            <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>📍 {d.location}</span>
            <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>→ {d.assignee}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Log Entry (with AI + Batch + Multi-photo) ────────────────────
function LogDefect({member,company,currentProject,members,onSave,existingDefects=[]}){
  const blank={title:"",location:"",severity:"Major",description:"",assignee:member?.name||"",photos:[],
    component:"",issue:"",locationLevel:"",locationZone:"",locationSubzone:"",locationGrid:"",
    entryType:"Defect",dueDate:"",duration:"",costImpact:"",costResponsible:"",costAmount:"",costRemarks:""};
  const[form,setForm]=useState(blank);

  const[saving,setSaving]=useState(false);const[analyzing,setAnalyzing]=useState(false);const[aiResult,setAiResult]=useState(null);
  const[count,setCount]=useState(0);const[last,setLast]=useState(null);const[showBatch,setShowBatch]=useState(false);
  const[showTypeManager,setShowTypeManager]=useState(false);
  const[customTypes,setCustomTypes]=useState(()=>getCustomTypes());
  const[newTypeName,setNewTypeName]=useState("");
  const[markupIdx,setMarkupIdx]=useState(null);
  const fileRef=useRef();
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
      if(result){
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
    if(!form.title.trim())return;
    // Build location display from hierarchy
    const locParts=[form.locationLevel,form.locationZone,form.locationSubzone,form.locationGrid].filter(Boolean);
    const locationDisplay=locParts.join(" > ")||form.location||"";
    if(!locationDisplay&&!form.location){alert("Please select a location.");return;}

    // Check for duplicates
    const dup=findDuplicate(form.title,locationDisplay);
    if(dup&&!confirm(`⚠️ Similar entry found:\n\n"${dup.title}"\n${dup.severity} · ${dup.status} · ${dup.location}\n${dup.defect_id||""}\n\nSubmit anyway?`))return;

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
        queued:saveResult==="queued"});
      setCount(c=>c+1);setShowBatch(true);setForm(blank);setAiResult(null);setShowMore(false);
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
        <button onClick={()=>setShowTypeManager(false)} style={{background:"rgba(0,0,0,0.06)",border:"none",borderRadius:20,padding:"7px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
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
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:last?.queued?"#ff9500":"#1a7a35",marginBottom:4}}>{last?.queued?"QUEUED OFFLINE":"ENTRY LOGGED"}</div>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)"}}>{count} logged this session · {last?.queued?"Will sync when online":"Team notified"}</div>
      </div>
      <div style={{background:"#fff",borderRadius:14,padding:14,marginBottom:12}}>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)",marginBottom:6}}>Log another at the same location?</div>
        <div style={{fontSize:12,color:"rgba(0,0,0,0.4)"}}>📍 {last?.location} · → {last?.assignee}</div>
      </div>
      <button onClick={()=>{setForm({...blank,
        location:last?.location||"",assignee:last?.assignee||member?.name||"",severity:last?.severity||"Major",
        locationLevel:last?.locationLevel||"",locationZone:last?.locationZone||"",component:last?.component||""
      });setShowBatch(false);}} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:12,padding:16,color:"#fff",fontSize:15,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10}}>+ LOG ANOTHER HERE</button>
      <button onClick={()=>setShowBatch(false)} style={{width:"100%",background:"rgba(0,0,0,0.06)",border:"none",borderRadius:12,padding:14,fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>DONE — VIEW ALL</button>
    </div>
  );

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>LOG ENTRY</div>
        {count>0&&<div style={{fontSize:10,fontWeight:700,color:"#30d158",background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>{count} LOGGED</div>}
        <div style={{fontSize:10,fontWeight:700,color:"#ff6b00",background:"rgba(255,107,0,0.1)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>🎙 VOICE</div>
      </div>
      <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginBottom:20}}>📁 {currentProject?.name||"—"} · Tap 🎙 to dictate</div>

      {/* Entry Type */}
      <div style={{marginBottom:16}}>
        <label style={lbl()}>ENTRY TYPE</label>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {getAllEntryTypes().map(t=>(
            <button key={t} onClick={()=>set("entryType",t)} style={{padding:"8px 14px",borderRadius:20,border:`2px solid ${form.entryType===t?typeColor(t):"rgba(0,0,0,0.12)"}`,background:form.entryType===t?typeBg(t):"#fff",color:form.entryType===t?typeColor(t):"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{typeIcon(t)} {t.toUpperCase()}</button>
          ))}
          <button onClick={()=>setShowTypeManager(true)} style={{padding:"8px 12px",borderRadius:20,border:"2px dashed rgba(0,0,0,0.15)",background:"#fff",color:"rgba(0,0,0,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>+ TYPE</button>
        </div>
      </div>

      {/* Component (grouped dropdown) */}
      <ComboField label="COMPONENT" value={form.component} onChange={v=>{set("component",v);set("issue","");}} grouped={COMPONENT_GROUPS} placeholder="e.g. Wall, Pipe, Tile..."/>

      {/* Issue (filtered by selected component) */}
      {form.component&&(
        <ComboField label="ISSUE" value={form.issue} onChange={v=>{set("issue",v);if(!form.title)set("title",form.component+" — "+v);}} options={COMPONENT_ISSUES[form.component]||COMPONENT_ISSUES["General"]} placeholder="Describe the issue..."/>
      )}

      <VoiceField label="TITLE *" value={form.title} onChange={v=>set("title",v)} placeholder="e.g. Crack in column C4"/>

      {/* Location hierarchy */}
      <ComboField label="LEVEL / FLOOR" value={form.locationLevel} onChange={v=>set("locationLevel",v)} options={DEFAULT_LEVELS} placeholder="e.g. 3rd Floor"/>
      <ComboField label="ZONE" value={form.locationZone} onChange={v=>set("locationZone",v)} options={DEFAULT_ZONES} placeholder="e.g. Zone A, Block B"/>
      <ComboField label="ROOM / AREA" value={form.locationSubzone} onChange={v=>set("locationSubzone",v)} options={DEFAULT_SUBZONES} placeholder="e.g. Kitchen, Bathroom"/>
      <VoiceField label="GRID REF (optional)" value={form.locationGrid} onChange={v=>set("locationGrid",v)} placeholder="e.g. C4, Grid 3-A"/>

      {/* Severity */}
      <div style={{marginBottom:16}}>
        <label style={lbl()}>SEVERITY</label>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {SEVERITY.map(s=>(
            <button key={s} onClick={()=>set("severity",s)} style={{padding:"8px 14px",borderRadius:20,border:`2px solid ${form.severity===s?SEV_COLOR[s]:"rgba(0,0,0,0.12)"}`,background:form.severity===s?SEV_BG[s]:"#fff",color:form.severity===s?SEV_COLOR[s]:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{s.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* Assignee */}
      <div style={{marginBottom:16}}>
        <label style={lbl()}>ASSIGN TO</label>
        <select value={form.assignee} onChange={e=>set("assignee",e.target.value)} style={{...inp,width:"100%",flex:"unset",appearance:"none"}}>
          {assignees.map(t=><option key={t}>{t}</option>)}
        </select>
      </div>

      <VoiceField label="DESCRIPTION" value={form.description} onChange={v=>set("description",v)} placeholder="Describe the issue..." multiline/>

      {/* Cost & Time */}
      <div style={{background:"rgba(0,0,0,0.02)",borderRadius:12,padding:14,marginBottom:16,border:"1px solid rgba(0,0,0,0.06)"}}>
        <div style={{marginBottom:12}}>
          <label style={lbl()}>TARGET DATE</label>
          <input type="date" value={form.dueDate} onChange={e=>set("dueDate",e.target.value)} style={{...inp,width:"100%",flex:"unset"}}/>
        </div>
        <ComboField label="ESTIMATED DURATION" value={form.duration} onChange={v=>set("duration",v)} options={DURATION_OPTIONS} placeholder="e.g. 3 days"/>
        <ComboField label="COST IMPACT" value={form.costImpact} onChange={v=>set("costImpact",v)} options={COST_IMPACT_OPTIONS} placeholder="e.g. No change"/>
        {form.costImpact&&form.costImpact!=="No change"&&form.costImpact!=="To be confirmed by QS"&&(
          <>
            <VoiceField label="COST AMOUNT" value={form.costAmount} onChange={v=>set("costAmount",v)} placeholder="e.g. $500, TBC"/>
            <ComboField label="COST RESPONSIBLE" value={form.costResponsible} onChange={v=>set("costResponsible",v)} options={COST_RESPONSIBLE_OPTIONS} placeholder="Who bears the cost?"/>
            <VoiceField label="COST REMARKS" value={form.costRemarks} onChange={v=>set("costRemarks",v)} placeholder="Contract clause, reference..." multiline/>
          </>
        )}
      </div>

      <div style={{marginBottom:20}}>
        <label style={lbl()}>PHOTOS ({form.photos.length}/{MAX_PHOTOS})</label>
        <input type="file" accept="image/*" capture="environment" multiple ref={fileRef} onChange={handlePhoto} style={{display:"none"}}/>
        {form.photos.length>0&&(
          <div>
            <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:8}}>
              {form.photos.map((p,i)=>(
                <div key={i} style={{position:"relative",flexShrink:0}}>
                  <img src={p} alt="" onClick={()=>setMarkupIdx(i)} style={{width:100,height:100,borderRadius:10,objectFit:"cover",cursor:"pointer"}}/>
                  <button onClick={()=>removePhoto(i)} style={{position:"absolute",top:4,right:4,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:22,height:22,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                  <div onClick={()=>setMarkupIdx(i)} style={{position:"absolute",bottom:4,left:4,background:"rgba(0,0,0,0.7)",borderRadius:10,padding:"2px 6px",color:"#fff",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>✏ MARKUP</div>
                </div>
              ))}
              {form.photos.length<MAX_PHOTOS&&(
                <button onClick={()=>fileRef.current.click()} style={{width:100,height:100,borderRadius:10,border:"2px dashed rgba(0,0,0,0.15)",background:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:24,color:"rgba(0,0,0,0.3)"}}>+</button>
              )}
            </div>
            {aiReady&&(
              <button onClick={analyze} disabled={analyzing} style={{width:"100%",background:"rgba(88,86,214,0.08)",border:"1.5px solid rgba(88,86,214,0.3)",borderRadius:10,padding:"11px",color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {analyzing?<><Spin size={14}/><span>ANALYZING...</span></>:<><span>🤖</span><span>ANALYZE WITH AI</span></>}
              </button>
            )}
            {!aiReady&&<div style={{fontSize:11,color:"rgba(0,0,0,0.35)",textAlign:"center",padding:"6px 0"}}>Setup AI (🤖 in header) to auto-fill from photo</div>}
            {aiResult&&(
              <div style={{background:"rgba(88,86,214,0.06)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"10px 12px",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#5856d6",marginBottom:4,fontFamily:"'Barlow Condensed',sans-serif"}}>AI FILLED — REVIEW & EDIT ABOVE</div>
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
        {form.photos.length===0&&(
          <button onClick={()=>fileRef.current.click()} style={{width:"100%",background:"#fff",border:"2px dashed rgba(0,0,0,0.15)",borderRadius:10,padding:20,color:"rgba(0,0,0,0.4)",fontSize:14,cursor:"pointer"}}>📷 Add photos (up to {MAX_PHOTOS}){aiReady?" · AI will auto-analyze":""}</button>
        )}
      </div>

      <button onClick={submit} disabled={saving||!form.title.trim()||(!form.locationLevel&&!form.location)} style={{width:"100%",background:form.title.trim()&&(form.locationLevel||form.location)&&!saving?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:12,padding:16,color:form.title.trim()&&(form.locationLevel||form.location)?"#fff":"rgba(0,0,0,0.3)",fontSize:16,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {saving?<><Spin size={16}/><span>SAVING...</span></>:"SUBMIT ENTRY"}
      </button>

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
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
          <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff"}}>AI SEARCH</div>
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

function DefectsList({defects,onView,nlFilters,onClearNl}){
  const[filter,setFilter]=useState("All");const[sevF,setSevF]=useState("All");const[typeF,setTypeF]=useState("All");
  const[search,setSearch]=useState("");const[showFilters,setShowFilters]=useState(false);
  const searchRef=useRef(null);

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
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>ALL ENTRIES <span style={{color:"rgba(0,0,0,0.3)",fontSize:18}}>({filtered.length})</span></div>
        {(activeFilters>0||q)&&<button onClick={clearAll} style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:20,padding:"4px 10px",color:"#ff3b30",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>CLEAR ({activeFilters+(q?1:0)})</button>}
      </div>

      {/* Search bar */}
      <div style={{position:"relative",marginBottom:14}}>
        <div style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"rgba(0,0,0,0.3)",pointerEvents:"none"}}>🔍</div>
        <input ref={searchRef} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, description, component, assignee, location..." style={{...inp,width:"100%",flex:"unset",paddingLeft:34,paddingRight:search?34:12,fontSize:13}}/>
        {search&&<button onClick={()=>{setSearch("");searchRef.current?.focus();}} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"rgba(0,0,0,0.08)",border:"none",borderRadius:"50%",width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,color:"rgba(0,0,0,0.4)",padding:0}}>×</button>}
      </div>

      {/* Filter toggle */}
      <button onClick={()=>setShowFilters(!showFilters)} style={{background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,padding:"8px 14px",marginBottom:showFilters?12:16,width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,color:"rgba(0,0,0,0.5)"}}>
        <span>FILTERS {activeFilters>0?`(${activeFilters} active)`:""}</span>
        <span style={{fontSize:10}}>{showFilters?"▲":"▼"}</span>
      </button>

      {showFilters&&(
        <div style={{marginBottom:16}}>
          {/* Type filter */}
          {typeFilterOptions.length>1&&(
            <div style={{marginBottom:10}}>
              <div style={lbl()}>TYPE</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {["All",...typeFilterOptions].map(t=>(
                  <button key={t} onClick={()=>setTypeF(t)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${typeF===t?(t==="All"?"#ff6b00":typeColor(t)):"rgba(0,0,0,0.12)"}`,background:typeF===t?(t==="All"?"#ff6b00":typeBg(t)):"#fff",color:typeF===t?(t==="All"?"#fff":typeColor(t)):"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{t==="All"?"ALL":typeIcon(t)+" "+t.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}
          <div style={{marginBottom:10}}>
            <div style={lbl()}>STATUS</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["All",...STATUS].map(s=>(
                <button key={s} onClick={()=>setFilter(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${filter===s?"#ff6b00":"rgba(0,0,0,0.12)"}`,background:filter===s?"#ff6b00":"#fff",color:filter===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={lbl()}>SEVERITY</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {["All",...SEVERITY].map(s=>(
                <button key={s} onClick={()=>setSevF(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${sevF===s?"#1a1a1a":"rgba(0,0,0,0.12)"}`,background:sevF===s?"#1a1a1a":"#fff",color:sevF===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {filtered.length===0&&<div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"50px 0",fontSize:14}}>{q?"No entries matching \""+search+"\"":"No entries found"}</div>}
      {filtered.map((d,i)=>(
        <div key={d.id} className="anim" style={{animationDelay:`${i*0.04}s`,background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",borderLeft:`4px solid ${SEV_COLOR[d.severity]}`}} onClick={()=>onView(d)}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,color:"#1a1a1a",flex:1,paddingRight:8}}><Highlight text={d.title} query={q}/></div>
            <StatusChip s={d.status}/>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:4}}>
            {d.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(d.entryType),background:typeBg(d.entryType),padding:"2px 8px",borderRadius:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(d.entryType)} {d.entryType.toUpperCase()}</span>}
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
      ))}
    </div>
  );
}

// ── Defect Detail ─────────────────────────────────────────────────
// ── Before/After Photo Comparison ────────────────────────────────
function BeforeAfter({before,after}){
  const[split,setSplit]=useState(50);
  const containerRef=useRef();
  const onMove=e=>{
    const rect=containerRef.current.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    const x=Math.max(5,Math.min(95,((t.clientX-rect.left)/rect.width)*100));
    setSplit(x);
  };
  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em",marginBottom:6}}>BEFORE / AFTER</div>
      <div ref={containerRef} style={{position:"relative",width:"100%",height:220,borderRadius:12,overflow:"hidden",cursor:"col-resize",touchAction:"none",background:"#f8f8f6"}}
        onMouseMove={e=>e.buttons===1&&onMove(e)} onTouchMove={onMove}>
        {/* After (full) */}
        <img src={after} alt="After" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}/>
        {/* Before (clipped) */}
        <div style={{position:"absolute",inset:0,width:`${split}%`,overflow:"hidden"}}>
          <img src={before} alt="Before" style={{width:containerRef.current?.clientWidth||"100%",height:"100%",objectFit:"cover"}}/>
        </div>
        {/* Slider line */}
        <div style={{position:"absolute",top:0,bottom:0,left:`${split}%`,width:3,background:"#fff",transform:"translateX(-50%)",boxShadow:"0 0 8px rgba(0,0,0,0.5)"}}>
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:28,height:28,borderRadius:"50%",background:"#fff",boxShadow:"0 2px 8px rgba(0,0,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#1a1a1a"}}>⇔</div>
        </div>
        {/* Labels */}
        <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.6)",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>BEFORE</div>
        <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>AFTER</div>
      </div>
    </div>
  );
}

function DefectDetail({defect,onClose,onUpdate,member,company}){
  const[status,setStatus]=useState(defect.status);
  const[comment,setComment]=useState("");const[saving,setSaving]=useState(false);const[deleting,setDeleting]=useState(false);
  const[commentPhoto,setCommentPhoto]=useState(null);const[verifyPhoto,setVerifyPhoto]=useState(null);
  const commentPhotoRef=useRef();const verifyPhotoRef=useRef();
  const latestRef=useRef(defect);
  useEffect(()=>{latestRef.current={...latestRef.current,...defect,status};},[defect,status]);
  const tgCfg=local.get(TG_KEY);
  const canUpdate=["Admin","Manager","Inspector"].includes(member?.role);
  const canDelete=member?.role==="Admin";

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
        verifyPhotoRef.current?.click();
        return;
      }
    }
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
        <button onClick={onClose} style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:20,padding:"7px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#1a1a1a",flex:1}}>ENTRY DETAIL</div>
        {canDelete&&<button onClick={deleteDefect} disabled={deleting} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{deleting?"...":"DELETE"}</button>}
      </div>
      <div style={{padding:16}}>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,borderLeft:`5px solid ${SEV_COLOR[defect.severity]}`}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:20,color:"#1a1a1a",marginBottom:10}}>{defect.title}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>{defect.entryType&&<span style={{fontSize:10,fontWeight:700,color:typeColor(defect.entryType),background:typeBg(defect.entryType),padding:"3px 10px",borderRadius:12,fontFamily:"'Barlow Condensed',sans-serif"}}>{typeIcon(defect.entryType)} {defect.entryType.toUpperCase()}</span>}<SevChip s={defect.severity}/><StatusChip s={status}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["📍 Location",defect.location],["👤 Assigned",defect.assignee],["📁 Project",defect.projectName||"—"],["🗓 Date",defect.created?new Date(defect.created).toLocaleDateString():"—"],["✍️ Logged by",defect.loggedBy],["🔑 Role",defect.loggedByRole||"—"]].map(([l,v])=>(
              <div key={l}><div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em"}}>{l}</div><div style={{fontSize:13,color:"#1a1a1a",marginTop:2}}>{v||"—"}</div></div>
            ))}
          </div>
          {defect.description&&(
            <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.06)"}}>
              <div style={{fontSize:10,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>DESCRIPTION</div>
              <div style={{fontSize:13,color:"#444",lineHeight:1.5}}>{defect.description}</div>
            </div>
          )}
        </div>

        {defect.photo&&(()=>{
          const origPhoto=typeof defect.photo==="string"?defect.photo:Array.isArray(defect.photo)&&defect.photo[0]?defect.photo[0]:null;
          const verifyComment=(latestRef.current.comments||[]).find(c=>c.text?.startsWith("✅")&&c.photo);
          const afterPhoto=verifyComment?.photo;
          return afterPhoto&&origPhoto?(
            <BeforeAfter before={origPhoto} after={afterPhoto}/>
          ):typeof defect.photo==="string"
            ?<img src={defect.photo} alt="" style={{maxWidth:"100%",borderRadius:12,maxHeight:350,objectFit:"contain",display:"block",marginBottom:14,background:"#f8f8f6"}}/>
            :Array.isArray(defect.photo)&&defect.photo.length>0
              ?<div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:14}}>
                {defect.photo.map((p,i)=><img key={i} src={p} alt="" style={{height:180,borderRadius:12,objectFit:"cover",flexShrink:0}}/>)}
              </div>
              :null;
        })()}

        {canUpdate&&(
          <div style={{marginBottom:14}}>
            <div style={lbl()}>UPDATE STATUS</div>
            <div style={{display:"flex",gap:8}}>
              {STATUS.map(s=>(
                <button key={s} onClick={()=>updateStatus(s)} style={{flex:1,padding:"10px 4px",borderRadius:10,border:`2px solid ${status===s?STATUS_COLOR[s]:"rgba(0,0,0,0.1)"}`,background:status===s?STATUS_COLOR[s]+"20":"#fff",color:status===s?STATUS_COLOR[s]:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{s.toUpperCase()}</button>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={lbl()}>TIMELINE ({(latestRef.current.comments||[]).length})</div>
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
                  {c.text&&<div style={{fontSize:13,color:"#333"}}>{c.text}</div>}
                  {c.photo&&<img src={c.photo} alt="" style={{width:"100%",maxHeight:200,objectFit:"contain",borderRadius:8,marginTop:6,background:"#f8f8f6"}}/>}
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
                <input value={comment} onChange={e=>setComment(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addComment()} placeholder="Add a comment..." style={{...inp,flex:1}}/>
                <MicBtn onResult={t=>setComment(c=>c+(c?" ":"")+t)} append currentValue={comment}/>
                <button onClick={addComment} disabled={saving||(!comment.trim()&&!commentPhoto)} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"11px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>{saving?"...":"POST"}</button>
              </div>
            </div>
          ):(
            <div style={{background:"rgba(0,0,0,0.04)",borderRadius:10,padding:"12px",textAlign:"center",fontSize:12,color:"rgba(0,0,0,0.4)"}}>Viewer access — comments disabled</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Report ────────────────────────────────────────────────────────
// ── Profile Panel (edit name, email, password) ──────────────────
function ProfilePanel({member,authUser,company,onClose,onEmailSettings,onSignOut}){
  const[editName,setEditName]=useState(member?.name||"");
  const[editEmail,setEditEmail]=useState(member?.email||authUser?.email||"");
  const[editJobTitle,setEditJobTitle]=useState(member?.jobTitle||"");
  const[oldPass,setOldPass]=useState("");const[newPass,setNewPass]=useState("");const[confirmPass,setConfirmPass]=useState("");
  const[saving,setSaving]=useState(false);const[msg,setMsg]=useState(null);

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
      <SettingsBack onClose={onClose} title="MY PROFILE"/>
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
            <button onClick={saveEmail} disabled={saving||!editEmail.trim()||editEmail===authUser?.email} style={{background:editEmail!==authUser?.email?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"10px 16px",color:editEmail!==authUser?.email?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0}}>SAVE</button>
          </div>
        </div>

        {/* Change Password */}
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:12}}>
          <div style={lbl()}>CHANGE PASSWORD</div>
          <input value={oldPass} onChange={e=>setOldPass(e.target.value)} type="password" placeholder="Current password" style={{...inp,width:"100%",marginBottom:8}}/>
          <input value={newPass} onChange={e=>setNewPass(e.target.value)} type="password" placeholder="New password (min 8 chars)" style={{...inp,width:"100%",marginBottom:8}}/>
          <input value={confirmPass} onChange={e=>setConfirmPass(e.target.value)} type="password" placeholder="Confirm new password" style={{...inp,width:"100%",marginBottom:10}}/>
          <button onClick={savePassword} disabled={saving||!oldPass||!newPass} style={{width:"100%",background:oldPass&&newPass?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:"12px",color:oldPass&&newPass?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>UPDATE PASSWORD</button>
        </div>

        {/* Actions */}
        <button onClick={onEmailSettings} style={{width:"100%",background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer",display:"flex",alignItems:"center",gap:10,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#1a1a1a"}}>📧 Email Report Settings</button>
        <button onClick={onSignOut} style={{width:"100%",background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.15)",borderRadius:14,padding:"14px 16px",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#ff3b30"}}>Sign Out</button>
      </div>
    </div>
  );
}

function Report({defects,onEmailSetup,currentProject,company}){
  const[sending,setSending]=useState(false);const[sendRes,setSendRes]=useState(null);
  const[showFilters,setShowFilters]=useState(false);
  const[sevFilter,setSevFilter]=useState([]);const[statusFilter,setStatusFilter]=useState([]);
  const[assigneeFilter,setAssigneeFilter]=useState([]);const[dateFrom,setDateFrom]=useState("");const[dateTo,setDateTo]=useState("");

  const emailCfg=local.get(EMAIL_KEY);
  const emailReady=!!(emailCfg?.publicKey&&emailCfg?.serviceId&&emailCfg?.templateId&&emailCfg?.recipients?.length);
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

  const sendReport=async()=>{
    if(!emailReady)return;
    setSending(true);setSendRes(null);
    try{
      emailjs.init(emailCfg.publicKey);
      const html=generateEmailHTML(filtered,currentProject?.name,company?.companyName);
      const date=new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
      for(const email of emailCfg.recipients.filter(r=>r.trim())){
        await emailjs.send(emailCfg.serviceId,emailCfg.templateId,{to_email:email,subject:`SiteShrimp Report – ${currentProject?.name||""} – ${date}`,html_content:html});
      }
      setSendRes("success");
    }catch(e){console.error(e);setSendRes("fail");}
    setSending(false);setTimeout(()=>setSendRes(null),4000);
  };

  const total=filtered.length;
  const bySev=SEVERITY.map(s=>({s,count:filtered.filter(d=>d.severity===s).length}));
  const byStatus=STATUS.map(s=>({s,count:filtered.filter(d=>d.status===s).length}));
  const byAssignee=allAssignees.map(t=>({t,open:filtered.filter(d=>d.assignee===t&&d.status==="Open").length,total:filtered.filter(d=>d.assignee===t).length})).filter(x=>x.total>0);

  const Chip=({label,active,color,onClick})=>(
    <button onClick={onClick} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${active?(color||"#1a1a1a"):"rgba(0,0,0,0.12)"}`,background:active?(color||"#1a1a1a"):"#fff",color:active?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{label}</button>
  );

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a",marginBottom:2}}>SITE REPORT</div>
      <div style={{fontSize:12,color:"rgba(0,0,0,0.4)",marginBottom:14}}>{currentProject?.name||""} · {new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</div>

      <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
        <button onClick={()=>setShowFilters(f=>!f)} style={{flex:1,background:showFilters?"#1a1a1a":"rgba(0,0,0,0.06)",border:"none",borderRadius:10,padding:"11px",color:showFilters?"#fff":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <span>▼ FILTER</span>
          {activeFilters>0&&<span style={{background:"#ff6b00",color:"#fff",borderRadius:20,padding:"1px 7px",fontSize:11}}>{activeFilters}</span>}
        </button>
        {activeFilters>0&&<button onClick={clearFilters} style={{background:"rgba(255,59,48,0.08)",border:"none",borderRadius:10,padding:"11px 14px",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CLEAR</button>}
      </div>

      {showFilters&&(
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
          <div style={{marginBottom:12}}><div style={lbl()}>SEVERITY</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{SEVERITY.map(s=><Chip key={s} label={s.toUpperCase()} active={sevFilter.includes(s)} color={SEV_COLOR[s]} onClick={()=>toggleArr(sevFilter,setSevFilter,s)}/>)}</div></div>
          <div style={{marginBottom:12}}><div style={lbl()}>STATUS</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{STATUS.map(s=><Chip key={s} label={s.toUpperCase()} active={statusFilter.includes(s)} color={STATUS_COLOR[s]} onClick={()=>toggleArr(statusFilter,setStatusFilter,s)}/>)}</div></div>
          {allAssignees.length>0&&<div style={{marginBottom:12}}><div style={lbl()}>ASSIGNEE</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{allAssignees.map(t=><Chip key={t} label={t} active={assigneeFilter.includes(t)} onClick={()=>toggleArr(assigneeFilter,setAssigneeFilter,t)}/>)}</div></div>}
          <div><div style={lbl()}>DATE RANGE</div><div style={{display:"flex",gap:8,alignItems:"center"}}><input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{...inp,flex:1,fontSize:13}}/><span style={{color:"rgba(0,0,0,0.3)",fontSize:12}}>to</span><input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{...inp,flex:1,fontSize:13}}/></div></div>
        </div>
      )}

      {activeFilters>0&&<div style={{background:"rgba(255,107,0,0.08)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:12,color:"#ff6b00",fontWeight:600}}>Showing {filtered.length} of {defects.length} defects</div>}

      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <button onClick={emailReady?sendReport:onEmailSetup} disabled={sending} style={{flex:1,background:"#ff6b00",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",opacity:sending?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {sending?<><Spin size={14}/><span>SENDING...</span></>:emailReady?"📧 EMAIL REPORT":"⚙️ SETUP EMAIL"}
        </button>
        <button onClick={()=>exportCSV(filtered,currentProject?.name)} style={{background:"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"12px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>📊 CSV</button>
        {emailReady&&<button onClick={onEmailSetup} style={{background:"rgba(0,0,0,0.07)",border:"none",borderRadius:10,padding:"12px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>EDIT</button>}
      </div>

      {sendRes&&(
        <div style={{background:sendRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${sendRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:14,color:sendRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>
          {sendRes==="success"?`✓ Report sent to ${emailCfg.recipients.length} recipient(s)!`:"✗ Failed. Check email settings."}
        </div>
      )}

      <div style={{background:"#1a1a1a",borderRadius:14,padding:20,marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing:"0.1em",fontFamily:"'Barlow Condensed',sans-serif",marginBottom:4}}>TOTAL DEFECTS</div>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:56,fontWeight:800,color:"#ff6b00",lineHeight:1}}>{total}</div>
      </div>

      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
        <div style={lbl()}>BY SEVERITY</div>
        {bySev.map(({s,count})=>(
          <div key={s} style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:SEV_COLOR[s]}}>{s.toUpperCase()}</span>
              <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13}}>{count}</span>
            </div>
            <div style={{background:"rgba(0,0,0,0.06)",borderRadius:4,height:6,overflow:"hidden"}}>
              <div style={{background:SEV_COLOR[s],height:"100%",width:total?`${(count/total)*100}%`:"0%",borderRadius:4}}/>
            </div>
          </div>
        ))}
      </div>

      <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14}}>
        <div style={lbl()}>BY STATUS</div>
        <div style={{display:"flex",gap:10}}>
          {byStatus.map(({s,count})=>(
            <div key={s} style={{flex:1,textAlign:"center",padding:"12px 8px",background:STATUS_COLOR[s]+"12",borderRadius:10}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:STATUS_COLOR[s]}}>{count}</div>
              <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,0.4)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em"}}>{s.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {byAssignee.length>0&&(
        <div style={{background:"#fff",borderRadius:14,padding:16}}>
          <div style={lbl()}>BY ASSIGNEE</div>
          {byAssignee.map(({t,open,total:tot})=>(
            <div key={t} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
              <span style={{fontSize:13,color:"#1a1a1a"}}>{t}</span>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {open>0&&<span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"#ff3b30",background:"rgba(255,59,48,0.1)",padding:"2px 8px",borderRadius:10}}>{open} open</span>}
                <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,color:"rgba(0,0,0,0.4)"}}>{tot} total</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Drawings & Floor Plan Pins ────────────────────────────────────
function DrawingsPanel({onClose,company,currentProject,member,defects,onSaveEntry,initialCompare}){
  const[drawings,setDrawings]=useState([]);const[loading,setLoading]=useState(true);
  const[viewing,setViewing]=useState(null);
  const[uploading,setUploading]=useState(false);
  const[allPins,setAllPins]=useState([]);
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
  const compareOverlayCanvasRef=useRef();
  const[compareMarkupTool,setCompareMarkupTool]=useState("freehand");
  const[compareMarkupColor,setCompareMarkupColor]=useState("#ff3b30");
  const[compareMarkupStrokes,setCompareMarkupStrokes]=useState([]);
  const[compareMarkupCurrent,setCompareMarkupCurrent]=useState(null);
  const[compareTextPoint,setCompareTextPoint]=useState(null);
  const[compareTextValue,setCompareTextValue]=useState("");
  const[savedComparisons,setSavedComparisons]=useState(()=>getSavedComparisons(currentProject?.id||""));
  const[viewingSaved,setViewingSaved]=useState(null);
  const fileRef=useRef();
  const compareBoardRef=useRef();
  const compareBaseCanvasRef=useRef();
  const compareTargetCanvasRef=useRef();
  const canUpload=["Admin","Manager"].includes(member?.role);
  const canApproveAi=["Admin","Manager"].includes(member?.role);
  const aiReady=isAiConfigured();
  const pdfDrawings=drawings.filter(d=>/\.pdf$/i.test(d.file||""));

  // Load drawings and all pins for current project
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    setLoading(true);
    DB.drawings.list(`companyId="${company.companyId}" && projectId="${currentProject.id}"`).then(items=>{
      setDrawings(items);setLoading(false);
      // Load pins for all drawings
      Promise.all(items.map(d=>DB.pins.list(`drawingId="${d.id}"`))).then(results=>{
        setAllPins(results.flat());
      }).catch(()=>{});
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

  const runCompare=async()=>{
    const base=drawings.find(d=>d.id===compareBaseId);
    const target=drawings.find(d=>d.id===compareTargetId);
    if(!base||!target||base.id===target.id){
      setCompareError("Choose 2 different PDF drawings.");
      return;
    }
    setComparing(true);setCompareError("");setCompareRes(null);
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
      const sampleAdded=(compareRes.added||[]).slice(0,80);
      const sampleRemoved=(compareRes.removed||[]).slice(0,80);
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

  const saveComparison=()=>{
    if(!compareRes&&!compareOverlayCanvasRef.current?.width){alert("Run a comparison first.");return;}
    // Capture overlay as thumbnail
    let overlayThumb="";
    try{
      const oc=compareOverlayCanvasRef.current;
      if(oc&&oc.width){
        const tmp=document.createElement("canvas");
        const scale=Math.min(400/oc.width,300/oc.height,1);
        tmp.width=Math.round(oc.width*scale);tmp.height=Math.round(oc.height*scale);
        tmp.getContext("2d").drawImage(oc,0,0,tmp.width,tmp.height);
        overlayThumb=tmp.toDataURL("image/jpeg",0.6);
      }
    }catch(e){}
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

  const onCompareMarkupDown=e=>{
    const p=getCompareMarkupPos(e);if(!p)return;
    e.preventDefault();
    if(compareMarkupTool==="text"){
      setCompareTextPoint(p);
      setCompareTextValue("");
      return;
    }
    if(compareMarkupTool==="freehand")setCompareMarkupCurrent({type:"freehand",color:compareMarkupColor,points:[p]});
    else setCompareMarkupCurrent({type:compareMarkupTool,color:compareMarkupColor,start:p,end:p});
  };

  const onCompareMarkupMove=e=>{
    if(!compareMarkupCurrent)return;
    const p=getCompareMarkupPos(e);if(!p)return;
    e.preventDefault();
    if(compareMarkupCurrent.type==="freehand")setCompareMarkupCurrent(c=>({...c,points:[...c.points,p]}));
    else setCompareMarkupCurrent(c=>({...c,end:p}));
  };

  const onCompareMarkupUp=()=>{
    if(compareMarkupCurrent){setCompareMarkupStrokes(s=>[...s,compareMarkupCurrent]);setCompareMarkupCurrent(null);}
  };

  const undoCompareMarkup=()=>setCompareMarkupStrokes(s=>s.slice(0,-1));
  const clearCompareMarkup=()=>{if(compareMarkupStrokes.length&&confirm("Clear compare markup?"))setCompareMarkupStrokes([]);};

  const addCompareText=()=>{
    if(!compareTextPoint||!compareTextValue.trim())return;
    setCompareMarkupStrokes(s=>[...s,{type:"text",color:compareMarkupColor,pos:compareTextPoint,text:compareTextValue.trim()}]);
    setCompareTextPoint(null);setCompareTextValue("");
  };

  const renderCompareMarkup=(strokes)=>strokes.map((s,i)=>{
    if(s.type==="freehand"&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={s.color} strokeWidth="0.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
    }
    if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      const angle=Math.atan2(dy,dx),hl=1.8;
      return <g key={i}><line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.5"/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle-0.45)} y2={s.end.y-hl*Math.sin(angle-0.45)} stroke={s.color} strokeWidth="0.5"/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle+0.45)} y2={s.end.y-hl*Math.sin(angle+0.45)} stroke={s.color} strokeWidth="0.5"/></g>;
    }
    if(s.type==="circle"&&s.start&&s.end){
      const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      if(rx<0.3&&ry<0.3)return null;
      return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={s.color} strokeWidth="0.5" fill="none"/>;
    }
    if(s.type==="text"&&s.pos&&s.text){
      return <g key={i}>
        <rect x={s.pos.x-0.2} y={s.pos.y-3.2} width={Math.max(8,s.text.length*1.3)} height="4" rx="0.6" fill="rgba(0,0,0,0.65)"/>
        <text x={s.pos.x+0.4} y={s.pos.y-0.6} fontSize="2.4" fontWeight="700" fill={s.color} fontFamily="Barlow Condensed, sans-serif">{s.text}</text>
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
    const renderPage=async(url,canvas,scale=1.2)=>{
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
          // Both have content — unchanged, show as black/dark gray
          const ink=Math.max(bInk,tInk);
          const v=255-ink;
          od[i]=v;od[i+1]=v;od[i+2]=v;od[i+3]=255;
        }else if(tHas&&!bHas){
          // Only in revision — ADDED — show as RED
          od[i]=255;od[i+1]=Math.max(0,255-tInk*2);od[i+2]=Math.max(0,255-tInk*2);od[i+3]=255;
        }else if(bHas&&!tHas){
          // Only in base — REMOVED — show as BLUE
          od[i]=Math.max(0,255-bInk*2);od[i+1]=Math.max(0,255-bInk*2);od[i+2]=255;od[i+3]=255;
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
      (sc.added||[]).forEach(l=>rows.push(["COMPARISON","ADDED",l,"","",`${sc.baseName}→${sc.targetName}`,new Date(sc.savedAt).toISOString(),proj,comp]));
      (sc.removed||[]).forEach(l=>rows.push(["COMPARISON","REMOVED",l,"","",`${sc.baseName}→${sc.targetName}`,new Date(sc.savedAt).toISOString(),proj,comp]));
    });

    if(rows.length===0){alert("No annotations or comparisons to export.");return;}

    const csv=[header,...rows].map(r=>r.map(cc).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${stamp}-${(proj||"export").replace(/\W+/g,"_")}_all_annotations.csv`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  const csvCell=v=>`"${String(v??"").replace(/"/g,'""')}"`;

  const exportCompareCsv=()=>{
    if(!compareRes)return;
    const stamp=new Date(compareRes.generatedAt||Date.now()).toISOString();
    const header=["Type","Line","Base Version","Revision Version","Generated At","Project","Company"];
    const rows=[];
    if(compareAiReport){
      rows.push(["AI_REPORT",compareAiReport.replace(/\n/g," | "),compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
      rows.push(["AI_APPROVAL",compareAiLocked?"LOCKED":"DRAFT",`By: ${compareAiApprovedBy||""} At: ${compareAiApprovedAt?new Date(compareAiApprovedAt).toISOString():""}`,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    }
    compareAuditLog.forEach(e=>rows.push(["AUDIT",`${e.action.toUpperCase()} by ${e.by} at ${new Date(e.at).toISOString()}${e.reason?" — Reason: "+e.reason:""}`,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    compareMarkupStrokes.filter(s=>s.type==="text"&&s.text).forEach(s=>rows.push(["MARKUP",s.text,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    if(compareMarkupStrokes.length>0)rows.push(["MARKUP_COUNT",`${compareMarkupStrokes.length} annotation(s): ${compareMarkupStrokes.filter(s=>s.type==="text").length} text, ${compareMarkupStrokes.filter(s=>s.type==="freehand").length} freehand, ${compareMarkupStrokes.filter(s=>s.type==="arrow").length} arrow, ${compareMarkupStrokes.filter(s=>s.type==="circle").length} circle`,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    compareRes.added.forEach(line=>rows.push(["ADDED",line,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    compareRes.removed.forEach(line=>rows.push(["REMOVED",line,compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]));
    if(rows.length===0)rows.push(["NO_DIFF","No added/removed lines detected",compareRes.baseName,compareRes.targetName,stamp,currentProject?.name||"",company?.companyName||""]);
    const csv=[header,...rows].map(r=>r.map(csvCell).join(",")).join("\n");
    const fn=`${fileTimestamp()}-compare_${(compareRes.baseName||"base").replace(/\W+/g,"_")}_to_${(compareRes.targetName||"revision").replace(/\W+/g,"_")}.csv`;
    downloadTextFile(csv,fn,"text/csv;charset=utf-8");
  };

  const exportComparePdf=()=>{
    if(!compareRes)return;
    const addedHtml=(compareRes.added.length?compareRes.added:["No added lines detected."]).map((l,i)=>`<tr><td>${i+1}</td><td>${sanitize(l)}</td></tr>`).join("");
    const removedHtml=(compareRes.removed.length?compareRes.removed:["No removed lines detected."]).map((l,i)=>`<tr><td>${i+1}</td><td>${sanitize(l)}</td></tr>`).join("");
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

  if(viewing)return <DrawingViewer drawing={viewing} onClose={()=>setViewing(null)} company={company} currentProject={currentProject} member={member} defects={defects} onSaveEntry={onSaveEntry}/>;

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title="DRAWINGS"/>
      <div style={{padding:20}}>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf,.pdf,.tif,.tiff" onChange={uploadDrawing} style={{display:"none"}}/>

        {/* Compact action bar */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:16}}>
          <div style={{flex:1,fontSize:12,color:"rgba(0,0,0,0.4)"}}>📁 {currentProject?.name}</div>
          {canUpload&&(
            <button onClick={()=>fileRef.current?.click()} disabled={uploading} title="Upload floor plan" style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.12)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {uploading?<Spin size={12}/>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 16V3m0 0L7 8m5-5l5 5" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" strokeLinecap="round"/></svg>}
            </button>
          )}
          {pdfDrawings.length>=2&&(
            <button onClick={openCompare} title="Compare PDF revisions" style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.12)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="18" rx="1.5" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5"/><rect x="13" y="3" width="8" height="18" rx="1.5" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5"/><path d="M7 8h0M7 12h0M17 8h0M17 12h0" stroke="rgba(0,0,0,0.45)" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          )}
          <button onClick={exportAll} title="Export all" style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.12)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* Saved comparisons */}
        {savedComparisons.length>0&&(
          <div style={{marginBottom:16}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>SAVED COMPARISONS ({savedComparisons.length})</div>
            {savedComparisons.map(sc=>(
              <div key={sc.id} style={{background:"#fff",borderRadius:12,padding:0,marginBottom:10,overflow:"hidden",border:"1px solid rgba(0,0,0,0.08)"}}>
                {sc.overlayThumb&&(
                  <div style={{position:"relative",cursor:"pointer"}} onClick={()=>loadSavedComparison(sc)}>
                    <img src={sc.overlayThumb} alt="Comparison overlay" style={{width:"100%",display:"block",maxHeight:200,objectFit:"contain",background:"#f8f8f6"}}/>
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
                    <button onClick={()=>deleteSavedComparison(sc.id)} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"5px 10px",color:"#ff3b30",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>DELETE</button>
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
            {canUpload&&<div style={{fontSize:12,marginTop:4}}>Upload a floor plan to get started</div>}
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
                            const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
                            return <path key={i} d={d} stroke={s.color} strokeWidth="0.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
                          }
                          if(s.type==="arrow"&&s.start&&s.end){
                            return <line key={i} x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.4"/>;
                          }
                          if(s.type==="circle"&&s.start&&s.end){
                            const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
                            const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
                            return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={s.color} strokeWidth="0.4" fill="none"/>;
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
                      <div key={n.id} style={{position:"absolute",left:`${n.x}%`,top:`${n.y}%`,transform:"translate(-50%,-50%)"}}>
                        <div style={{background:"rgba(88,86,214,0.85)",borderRadius:6,padding:"1px 5px",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}>
                          <span style={{fontSize:8,color:"#fff",fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",whiteSpace:"nowrap"}}>📝</span>
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
                  {member?.role==="Admin"&&<button onClick={e=>{e.stopPropagation();deleteDrawing(d.id);}} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:"#ff3b30",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>DELETE</button>}
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
      </div>

      {showCompare&&(
        <div style={{position:"fixed",inset:0,zIndex:260,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div style={{width:"100%",maxWidth:430,maxHeight:"92vh",background:"#1a1a1a",borderTopLeftRadius:18,borderTopRightRadius:18,overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"14px 16px",borderBottom:"1px solid rgba(255,255,255,0.08)",display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff"}}>PDF COMPARISON{viewingSaved?` (SAVED)`:""}
              </div>
              <button onClick={saveComparison} disabled={!compareRes&&!compareOverlayCanvasRef.current?.width} style={{background:"rgba(52,199,89,0.25)",border:"1px solid rgba(52,199,89,0.5)",borderRadius:18,padding:"7px 14px",color:"#9ef0b5",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer",opacity:(!compareRes&&!compareOverlayCanvasRef.current?.width)?0.4:1}}>SAVE</button>
              <button onClick={()=>{setShowCompare(false);setViewingSaved(null);}} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:18,padding:"7px 12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CLOSE</button>
            </div>

            <div style={{padding:16,overflowY:"auto"}}>
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
                {comparing?"COMPARING...":"RUN COMPARISON"}
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

                  {/* Overlay diff view — Autodesk Design Review style, with markup support */}
                  <div ref={compareBoardRef} style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1px solid rgba(255,255,255,0.18)",background:"#fff",marginBottom:8,touchAction:"none"}}
                    onMouseDown={onCompareMarkupDown} onMouseMove={onCompareMarkupMove} onMouseUp={onCompareMarkupUp} onMouseLeave={onCompareMarkupUp}
                    onTouchStart={onCompareMarkupDown} onTouchMove={onCompareMarkupMove} onTouchEnd={onCompareMarkupUp}>
                    <canvas ref={compareOverlayCanvasRef} style={{width:"100%",display:"block",background:"#fff"}}/>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}}>
                      {renderCompareMarkup(compareMarkupStrokes)}
                      {compareMarkupCurrent&&renderCompareMarkup([compareMarkupCurrent])}
                    </svg>
                    <div style={{position:"absolute",left:6,top:6,display:"flex",gap:4,flexWrap:"wrap",pointerEvents:"none"}}>
                      <div style={{background:"rgba(0,0,0,0.75)",borderRadius:6,padding:"3px 8px",fontSize:9,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",display:"flex",alignItems:"center",gap:4}}>
                        <span style={{width:10,height:3,background:"#ff0000",display:"inline-block"}}/>
                        <span style={{color:"#ff8a8a"}}>ADDED</span>
                      </div>
                      <div style={{background:"rgba(0,0,0,0.75)",borderRadius:6,padding:"3px 8px",fontSize:9,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",display:"flex",alignItems:"center",gap:4}}>
                        <span style={{width:10,height:3,background:"#0055ff",display:"inline-block"}}/>
                        <span style={{color:"#8ab4ff"}}>REMOVED</span>
                      </div>
                      <div style={{background:"rgba(0,0,0,0.75)",borderRadius:6,padding:"3px 8px",fontSize:9,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",display:"flex",alignItems:"center",gap:4}}>
                        <span style={{width:10,height:3,background:"#000",display:"inline-block"}}/>
                        <span style={{color:"#aaa"}}>UNCHANGED</span>
                      </div>
                    </div>
                    {comparePreviewLoading&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(255,255,255,0.7)",color:"#333",fontSize:12}}><Spin size={14}/> <span style={{marginLeft:8}}>Generating overlay diff...</span></div>}
                  </div>
                </div>
              )}

              {/* AI analysis controls */}
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
                    {compareAiLocked?"AI REPORT LOCKED":"AI REPORT DRAFT"}
                    {compareAiApprovedBy?` · ${compareAiApprovedBy}`:""}
                    {compareAiApprovedAt?` · ${new Date(compareAiApprovedAt).toLocaleString()}`:""}
                  </div>
                  {canApproveAi&&(
                    <div style={{display:"flex",gap:8}}>
                      {!compareAiLocked&&<button onClick={approveAndLockCompareAi} style={{flex:1,background:"rgba(52,199,89,0.2)",border:"1px solid rgba(52,199,89,0.4)",borderRadius:8,padding:"8px 10px",color:"#9ef0b5",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>APPROVE & LOCK</button>}
                      {compareAiLocked&&<button onClick={unlockCompareAi} style={{flex:1,background:"rgba(255,149,0,0.18)",border:"1px solid rgba(255,149,0,0.4)",borderRadius:8,padding:"8px 10px",color:"#ffd08a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,cursor:"pointer"}}>UNLOCK</button>}
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
                  {[{id:"freehand",label:"✏"},{id:"arrow",label:"↗"},{id:"circle",label:"○"},{id:"text",label:"T"}].map(t=>(
                    <button key={t.id} onClick={()=>setCompareMarkupTool(t.id)} style={{width:34,height:34,borderRadius:8,border:compareMarkupTool===t.id?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:compareMarkupTool===t.id?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{t.label}</button>
                  ))}
                  <div style={{width:1,height:20,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
                  {["#ff3b30","#ff9500","#ffcc00","#34c759","#fff"].map(c=>(
                    <button key={c} onClick={()=>setCompareMarkupColor(c)} style={{width:22,height:22,borderRadius:"50%",border:compareMarkupColor===c?"3px solid #fff":"2px solid rgba(255,255,255,0.2)",background:c,cursor:"pointer"}}/>
                  ))}
                  <div style={{flex:1}}/>
                  <button onClick={undoCompareMarkup} disabled={!compareMarkupStrokes.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:compareMarkupStrokes.length?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>UNDO</button>
                  <button onClick={clearCompareMarkup} disabled={!compareMarkupStrokes.length} style={{background:"rgba(255,59,48,0.2)",border:"none",borderRadius:8,padding:"6px 10px",color:compareMarkupStrokes.length?"#ff8f8f":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>CLEAR</button>
                </div>
              )}

              {compareRes&&(
                <div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:10}}>
                    {compareRes.baseName} → {compareRes.targetName} · {new Date(compareRes.generatedAt).toLocaleString()}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:12}}>
                    <button onClick={exportCompareCsv} style={{flex:1,background:"rgba(52,170,220,0.25)",border:"1px solid rgba(52,170,220,0.45)",borderRadius:10,padding:"9px 10px",color:"#7fd7ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT CSV</button>
                    <button onClick={exportComparePdf} style={{flex:1,background:"rgba(255,107,0,0.22)",border:"1px solid rgba(255,107,0,0.4)",borderRadius:10,padding:"9px 10px",color:"#ffb48a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>EXPORT PDF</button>
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:12}}>
                    <div style={{flex:1,background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:10}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:BCA_SCDF_REVISION_COLORS.added}}>ADDED LINES</div>
                      <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>{compareRes.totalAdded}</div>
                    </div>
                    <div style={{flex:1,background:"rgba(52,199,89,0.14)",border:"1px solid rgba(52,199,89,0.3)",borderRadius:10,padding:10}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:BCA_SCDF_REVISION_COLORS.removed}}>REMOVED LINES</div>
                      <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>{compareRes.totalRemoved}</div>
                    </div>
                  </div>

                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:11,fontWeight:700,color:BCA_SCDF_REVISION_COLORS.added,marginBottom:6,fontFamily:"'Barlow Condensed',sans-serif"}}>ADDED (RED)</div>
                    <div style={{maxHeight:180,overflowY:"auto",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:10}}>
                      {compareRes.added.length===0&&<div style={{fontSize:12,color:"rgba(255,255,255,0.45)"}}>No added lines detected.</div>}
                      {compareRes.added.map((line,i)=><div key={i} style={{fontSize:11,color:"rgba(255,255,255,0.86)",padding:"4px 0",borderBottom:i===compareRes.added.length-1?"none":"1px solid rgba(255,255,255,0.06)",wordBreak:"break-word"}}>{line}</div>)}
                    </div>
                  </div>

                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:BCA_SCDF_REVISION_COLORS.removed,marginBottom:6,fontFamily:"'Barlow Condensed',sans-serif"}}>REMOVED (GREEN)</div>
                    <div style={{maxHeight:180,overflowY:"auto",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:10}}>
                      {compareRes.removed.length===0&&<div style={{fontSize:12,color:"rgba(255,255,255,0.45)"}}>No removed lines detected.</div>}
                      {compareRes.removed.map((line,i)=><div key={i} style={{fontSize:11,color:"rgba(255,255,255,0.86)",padding:"4px 0",borderBottom:i===compareRes.removed.length-1?"none":"1px solid rgba(255,255,255,0.06)",wordBreak:"break-word"}}>{line}</div>)}
                    </div>
                  </div>
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
                      <button onClick={()=>{setCompareTextPoint(null);setCompareTextValue("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CANCEL</button>
                      <button onClick={addCompareText} disabled={!compareTextValue.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:compareTextValue.trim()?"#5856d6":"rgba(255,255,255,0.1)",color:compareTextValue.trim()?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD</button>
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
                      <button onClick={()=>{setShowUnlockPrompt(false);setUnlockReason("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CANCEL</button>
                      <button onClick={()=>confirmUnlock(unlockReason.trim())} disabled={!unlockReason.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:unlockReason.trim()?"rgba(255,149,0,0.35)":"rgba(255,255,255,0.1)",color:unlockReason.trim()?"#ffd08a":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>CONFIRM UNLOCK</button>
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
  const[markupColor,setMarkupColor]=useState("#ff3b30");const[markupStrokes,setMarkupStrokes]=useState(()=>getDrawingMarkup(drawing.id));
  const[markupCurrent,setMarkupCurrent]=useState(null);
  const[notes,setNotes]=useState([]);
  const[pendingNotePos,setPendingNotePos]=useState(null);
  const[noteText,setNoteText]=useState("");
  const[showCombinedList,setShowCombinedList]=useState(true);
  const markupSvgRef=useRef();
  const imgRef=useRef();const containerRef=useRef();const canvasRef=useRef();const pdfDocRef=useRef(null);
  const canPin=["Admin","Manager","Inspector"].includes(member?.role);
  const fileUrl=DB.fileUrl("drawings",drawing.id,drawing.file);
  const isImage=/\.(jpg|jpeg|png|gif|webp)$/i.test(drawing.file);
  const isPdf=/\.pdf$/i.test(drawing.file);

  // Load pins
  useEffect(()=>{
    DB.pins.list(`drawingId="${drawing.id}"`).then(items=>{setPins(items);setLoading(false);}).catch(()=>setLoading(false));
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
    if(activePin){setActivePin(null);return;}
    if(!placing)return;
    const target=isImage?imgRef.current:canvasRef.current;
    if(!target)return;
    const rect=target.getBoundingClientRect();
    const x=((e.clientX-rect.left)/rect.width*100).toFixed(2);
    const y=((e.clientY-rect.top)/rect.height*100).toFixed(2);
    setLinkEntry({x:parseFloat(x),y:parseFloat(y),pageNum:currentPage});
    setPlacing(false);
  };

  // Save pin linked to entry
  const savePin=async(entryId)=>{
    if(!linkEntry)return;
    try{
      const pin=await DB.pins.create({drawingId:drawing.id,entryId,pageNum:linkEntry.pageNum||1,x:linkEntry.x,y:linkEntry.y,label:""});
      setPins(prev=>[...prev,pin]);
    }catch(e){alert("Failed to place pin: "+e.message);}
    setLinkEntry(null);
  };

  // Delete pin
  const deletePin=async id=>{
    await DB.pins.delete(id);
    setPins(prev=>prev.filter(p=>p.id!==id));
  };

  // Zoom controls
  const zoomIn=()=>setScale(s=>Math.min(s+0.3,4));
  const zoomOut=()=>setScale(s=>Math.max(s-0.3,0.5));
  const resetZoom=()=>{setScale(1);setOffset({x:0,y:0});};

  // Page navigation
  const prevPage=()=>setCurrentPage(p=>Math.max(1,p-1));
  const nextPage=()=>setCurrentPage(p=>Math.min(pdfPageCount,p+1));

  // Drag for panning (single pointer when not placing, always for multi-touch)
  const dragRef=useRef(null);
  const pointerCount=useRef(0);
  const onPointerDown=e=>{
    pointerCount.current++;
    // Allow pan with one finger when not placing, or always with two fingers
    if(!placing||pointerCount.current>=2){
      dragRef.current={startX:e.clientX-offset.x,startY:e.clientY-offset.y};
    }
  };
  const onPointerMove=e=>{
    if(dragRef.current){setOffset({x:e.clientX-dragRef.current.startX,y:e.clientY-dragRef.current.startY});}
  };
  const onPointerUp=()=>{pointerCount.current=Math.max(0,pointerCount.current-1);if(pointerCount.current===0)dragRef.current=null;};

  // Pinch-to-zoom for mobile
  const lastPinchDist=useRef(null);
  const onTouchMove=e=>{
    if(e.touches.length===2){
      e.preventDefault();
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      const dist=Math.sqrt(dx*dx+dy*dy);
      if(lastPinchDist.current!==null){
        const delta=(dist-lastPinchDist.current)*0.005;
        setScale(s=>Math.min(Math.max(s+delta,0.5),4));
      }
      lastPinchDist.current=dist;
    }
  };
  const onTouchEnd=()=>{lastPinchDist.current=null;};

  // Drawing markup handlers
  const getMarkupPos=e=>{
    const svg=markupSvgRef.current;if(!svg)return null;
    const rect=svg.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{x:((t.clientX-rect.left)/rect.width*100),y:((t.clientY-rect.top)/rect.height*100)};
  };
  const onMarkupDown=e=>{
    if(!markupMode)return;e.preventDefault();e.stopPropagation();
    const p=getMarkupPos(e);if(!p)return;
    if(markupTool==="text"){
      setPendingNotePos({...p,pageNum:isPdf?currentPage:1});
      setNoteText("");
      return;
    }
    if(markupTool==="freehand")setMarkupCurrent({type:"freehand",color:markupColor,points:[p]});
    else setMarkupCurrent({type:markupTool,color:markupColor,start:p,end:p});
  };
  const onMarkupMove=e=>{
    if(!markupCurrent)return;e.preventDefault();e.stopPropagation();
    const p=getMarkupPos(e);if(!p)return;
    if(markupCurrent.type==="freehand")setMarkupCurrent(c=>({...c,points:[...c.points,p]}));
    else setMarkupCurrent(c=>({...c,end:p}));
  };
  const onMarkupUp=()=>{
    if(markupCurrent){setMarkupStrokes(s=>[...s,markupCurrent]);setMarkupCurrent(null);}
  };
  const undoMarkup=()=>setMarkupStrokes(s=>s.slice(0,-1));
  const clearMarkup=()=>{if(markupStrokes.length&&confirm("Clear all markup?"))setMarkupStrokes([]);};

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
    if(s.type==="freehand"&&s.points.length>1){
      const d="M"+s.points.map(p=>`${p.x} ${p.y}`).join("L");
      return <path key={i} d={d} stroke={s.color} strokeWidth="0.3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
    }else if(s.type==="arrow"&&s.start&&s.end){
      const dx=s.end.x-s.start.x,dy=s.end.y-s.start.y,len=Math.sqrt(dx*dx+dy*dy);
      if(len<0.5)return null;
      const angle=Math.atan2(dy,dx),hl=1.5;
      return <g key={i}><line x1={s.start.x} y1={s.start.y} x2={s.end.x} y2={s.end.y} stroke={s.color} strokeWidth="0.3"/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle-0.4)*1.5} y2={s.end.y-hl*Math.sin(angle-0.4)*1.5} stroke={s.color} strokeWidth="0.3"/>
        <line x1={s.end.x} y1={s.end.y} x2={s.end.x-hl*Math.cos(angle+0.4)*1.5} y2={s.end.y-hl*Math.sin(angle+0.4)*1.5} stroke={s.color} strokeWidth="0.3"/></g>;
    }else if(s.type==="circle"&&s.start&&s.end){
      const cx=(s.start.x+s.end.x)/2,cy=(s.start.y+s.end.y)/2;
      const rx=Math.abs(s.end.x-s.start.x)/2,ry=Math.abs(s.end.y-s.start.y)/2;
      if(rx<0.3&&ry<0.3)return null;
      return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} stroke={s.color} strokeWidth="0.3" fill="none"/>;
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

  const exportDrawingPdf=()=>{
    const stamp=new Date().toLocaleString();
    const itemsHtml=combinedItems.length?combinedItems.map((item,i)=>`<tr><td>${i+1}</td><td style="color:${item.kind==="pin"?"#ff3b30":item.kind==="note"?"#5856d6":"#ff6b00"};font-weight:700">${item.kind.toUpperCase()}</td><td>${sanitize(item.title)}</td><td>${sanitize(item.severity)}</td><td>${sanitize(item.detail||"")}</td></tr>`).join(""):`<tr><td colspan="5" style="text-align:center;color:#999">No annotations</td></tr>`;
    const w=window.open("","_blank");
    if(!w){alert("Popup blocked.");return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${fileTimestamp()}-${sanitize(drawing.name)}_annotations</title><style>body{font-family:Arial,sans-serif;padding:22px;color:#111}h1{margin:0 0 4px;font-size:20px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f5f5f5;text-align:left}.meta{font-size:12px;color:#444;margin-bottom:4px}@media print{.no-print{display:none}}</style></head><body><h1>Drawing Annotations — ${sanitize(drawing.name)}</h1><div class="meta"><b>Project:</b> ${sanitize(currentProject?.name||"—")} | <b>Company:</b> ${sanitize(company?.companyName||"—")} | <b>Generated:</b> ${sanitize(stamp)}</div><div class="meta"><b>Total:</b> ${combinedItems.length} items (${combinedItems.filter(i=>i.kind==="pin").length} pins, ${combinedItems.filter(i=>i.kind==="note").length} notes, ${combinedItems.filter(i=>i.kind==="markup").length} markups)</div><table><tr><th>#</th><th>Type</th><th>Title / Content</th><th>Category</th><th>Detail</th></tr>${itemsHtml}</table><br><button class="no-print" onclick="window.print()">Print / Save as PDF</button></body></html>`);
    w.document.close();
  };

  // Shared pin overlay
  const renderPins=()=>pagePins.map(p=>{
    const d=getDefect(p.entryId);
    const color=d?SEV_COLOR[d.severity]||"#ff6b00":"#8e8e93";
    const isActive=activePin===p.id;
    const isCritical=d?.severity==="Critical";
    const isOpen=d?.status==="Open";
    return(
      <div key={p.id} style={{position:"absolute",left:`${p.x}%`,top:`${p.y}%`,transform:"translate(-50%,-50%)",zIndex:isActive?15:5,cursor:"pointer"}}
        onClick={e=>{e.stopPropagation();setActivePin(isActive?null:p.id);}}>
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
      <div style={{background:"#1a1a1a",padding:"12px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
        <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"#fff"}}>{drawing.name}</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>{pins.length} pin(s){isPdf&&pdfPageCount>0?` · Page ${currentPage}/${pdfPageCount}`:""}</div>
        </div>
        {canPin&&!markupMode&&(
          <button onClick={()=>setPlacing(!placing)} style={{background:placing?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {placing?"TAP TO PLACE":"📌 ADD PIN"}
          </button>
        )}
        {canPin&&!placing&&(
          <button onClick={()=>setMarkupMode(!markupMode)} style={{background:markupMode?"#5856d6":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {markupMode?"DONE":"✏ MARKUP"}
          </button>
        )}
        <button onClick={()=>setShowCombinedList(v=>!v)} style={{background:showCombinedList?"rgba(255,107,0,0.22)":"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>
          LIST ({combinedItems.length})
        </button>
      </div>

      {/* Zoom controls */}
      <div style={{position:"absolute",right:12,top:70,zIndex:10,display:"flex",flexDirection:"column",gap:6}}>
        <button onClick={zoomIn} style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
        <button onClick={resetZoom} style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{Math.round(scale*100)}%</button>
        <button onClick={zoomOut} style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
        {pagePins.length>0&&<button onClick={()=>setShowHeatmap(!showHeatmap)} style={{width:36,height:36,borderRadius:10,background:showHeatmap?"rgba(255,59,48,0.6)":"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",marginTop:4}} title="Heatmap">🔥</button>}
      </div>

      {/* PDF page navigation */}
      {isPdf&&pdfPageCount>1&&(
        <div style={{position:"absolute",left:12,top:70,zIndex:10,display:"flex",flexDirection:"column",gap:6}}>
          <button onClick={prevPage} disabled={currentPage<=1} style={{width:36,height:36,borderRadius:10,background:currentPage<=1?"rgba(0,0,0,0.3)":"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:16,cursor:currentPage<=1?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>▲</button>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(0,0,0,0.6)",color:"#fff",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{currentPage}</div>
          <button onClick={nextPage} disabled={currentPage>=pdfPageCount} style={{width:36,height:36,borderRadius:10,background:currentPage>=pdfPageCount?"rgba(0,0,0,0.3)":"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:16,cursor:currentPage>=pdfPageCount?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>▼</button>
        </div>
      )}

      {/* Placing mode indicator */}
      {placing&&<div style={{background:"#ff6b00",padding:"8px 16px",textAlign:"center",color:"#fff",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",flexShrink:0}}>TAP ON THE DRAWING TO PLACE A PIN</div>}

      {/* Markup toolbar */}
      {markupMode&&(
        <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:6,background:"#1a1a1a",borderBottom:"1px solid rgba(255,255,255,0.1)",flexShrink:0}}>
          {[{id:"freehand",label:"✏"},{id:"arrow",label:"↗"},{id:"circle",label:"○"},{id:"text",label:"T"}].map(t=>(
            <button key={t.id} onClick={()=>setMarkupTool(t.id)} style={{width:36,height:36,borderRadius:8,border:markupTool===t.id?"2px solid #5856d6":"2px solid rgba(255,255,255,0.15)",background:markupTool===t.id?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.05)",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{t.label}</button>
          ))}
          <div style={{width:1,height:24,background:"rgba(255,255,255,0.15)",margin:"0 2px"}}/>
          {["#ff3b30","#ff9500","#ffcc00","#fff"].map(c=>(
            <button key={c} onClick={()=>setMarkupColor(c)} style={{width:24,height:24,borderRadius:"50%",border:markupColor===c?"3px solid #fff":"3px solid rgba(255,255,255,0.15)",background:c,cursor:"pointer",flexShrink:0}}/>
          ))}
          <div style={{flex:1}}/>
          <button onClick={undoMarkup} disabled={!markupStrokes.length} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:8,padding:"6px 10px",color:markupStrokes.length?"#fff":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>UNDO</button>
          <button onClick={clearMarkup} disabled={!markupStrokes.length} style={{background:"rgba(255,59,48,0.2)",border:"none",borderRadius:8,padding:"6px 10px",color:markupStrokes.length?"#ff6b6b":"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>CLEAR</button>
        </div>
      )}

      {/* Drawing canvas */}
      <div ref={containerRef} style={{flex:1,overflow:"hidden",position:"relative",cursor:markupMode?"crosshair":placing?"crosshair":"grab",touchAction:"none"}}
        onPointerDown={markupMode?undefined:onPointerDown} onPointerMove={markupMode?undefined:onPointerMove} onPointerUp={markupMode?undefined:onPointerUp} onPointerCancel={markupMode?undefined:onPointerUp}
        onTouchMove={markupMode?undefined:onTouchMove} onTouchEnd={markupMode?undefined:onTouchEnd}>
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
                {item.kind==="note"&&canPin&&<button onClick={()=>deleteNote(item.id)} style={{background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:7,padding:"4px 8px",color:"#ff8f8f",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif"}}>DELETE</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Text note modal for markup text tool */}
      {pendingNotePos&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.84)",zIndex:320,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:360,background:"#1a1a1a",borderRadius:16,padding:18,border:"1px solid rgba(255,255,255,0.12)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:15,color:"#fff",marginBottom:6}}>ADD DRAWING NOTE</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:12}}>Type or dictate a note. This appears in the consolidated list with pins and defects.</div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input autoFocus value={noteText} onChange={e=>setNoteText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addNote()} placeholder="Type note or annotation..." style={{flex:1,padding:"12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:13,fontFamily:"'Barlow Condensed',sans-serif",boxSizing:"border-box"}}/>
              <MicBtn onResult={t=>setNoteText(v=>v?(v+" "+t):t)} append currentValue={noteText}/>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setPendingNotePos(null);setNoteText("");}} style={{flex:1,padding:10,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.55)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>CANCEL</button>
              <button onClick={addNote} disabled={!noteText.trim()} style={{flex:1,padding:10,borderRadius:10,border:"none",background:noteText.trim()?"#5856d6":"rgba(255,255,255,0.1)",color:noteText.trim()?"#fff":"rgba(255,255,255,0.35)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>ADD NOTE</button>
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
            <button onClick={()=>setLinkEntry(null)} style={{width:"100%",background:"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:12,color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",marginTop:4}}>CANCEL</button>
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
            <div style={{display:"flex",gap:6,marginBottom:16}}>
              {SEVERITY.map(s=>(
                <button key={s} onClick={()=>setQSev(s)} style={{flex:1,padding:"8px 4px",borderRadius:8,border:`2px solid ${qSev===s?SEV_COLOR[s]:"rgba(255,255,255,0.1)"}`,background:qSev===s?SEV_COLOR[s]+"30":"rgba(255,255,255,0.05)",color:qSev===s?SEV_COLOR[s]:"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:10,cursor:"pointer"}}>{s.toUpperCase()}</button>
              ))}
            </div>
            {/* Actions */}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setQuickCreate(false);setQTitle("");setQPhoto(null);}} style={{flex:1,padding:12,borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"none",color:"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>BACK</button>
              <button disabled={!qTitle.trim()||qSaving} onClick={async()=>{
                setQSaving(true);
                try{
                  let photo=null;
                  if(qPhoto){photo=await compressPhoto(qPhoto);}
                  const entryData={title:qTitle,severity:qSev,status:"Open",entryType:"Defect",
                    location:drawing.name,description:"Pinned on: "+drawing.name,
                    photo:photo||null,extraPhotos:[],
                    projectId:currentProject?.id||"default",projectName:currentProject?.name||"",
                    loggedBy:member?.name||"",loggedByRole:member?.role||"",
                    createdAt:DB.serverTimestamp(),updatedAt:DB.serverTimestamp(),comments:[]};
                  await onSaveEntry(entryData);
                  // Reload defects to get the new entry, then pin it
                  const allEntries=await DB.defects.list(`companyId="${company.companyId}" && projectId="${currentProject?.id}"`,"-created");
                  const newEntry=allEntries.find(e=>e.title===qTitle);
                  if(newEntry){
                    const pin=await DB.pins.create({drawingId:drawing.id,entryId:newEntry.id,pageNum:linkEntry.pageNum||1,x:linkEntry.x,y:linkEntry.y,label:""});
                    setPins(prev=>[...prev,pin]);
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
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>ADMIN ANALYTICS</div>
        <div style={{fontSize:10,fontWeight:700,color:"#ff3b30",background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>ADMIN ONLY</div>
      </div>
      <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginBottom:20}}>📁 {currentProject?.name||"All"} · {company?.companyName}</div>

      {/* Entries logged today/week/month */}
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:8}}>ENTRIES LOGGED</div>
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <StatCard label="TODAY" value={today} color="#30d158"/>
        <StatCard label="THIS WEEK" value={week} color="#34aadc"/>
        <StatCard label="THIS MONTH" value={month} color="#ff9500"/>
        <StatCard label="ALL TIME" value={defects.length} color="#8e8e93"/>
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
        <StatCard label="TOTAL PHOTOS" value={totalPhotos} color="#5856d6"/>
        <StatCard label="AVG / ENTRY" value={avgPhotos} color="#e91e63"/>
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
const NAV=[{id:"dashboard",icon:"⊞",label:"Dashboard"},{id:"log",icon:"+",label:"Log"},{id:"defects",icon:"≡",label:"Items"},{id:"report",icon:"◎",label:"Report"},{id:"admin",icon:"⚡",label:"Admin"}];


function App(){
  const[authUser,setAuthUser]=useState(null);
  const[authLoading,setAuthLoading]=useState(true);
  const[memberLoading,setMemberLoading]=useState(false);
  const[inviteCode,setInviteCode]=useState("");
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
  const[showHeaderMenu,setShowHeaderMenu]=useState(false);
  const[showUsers,setShowUsers]=useState(false);
  const[showProjects,setShowProjects]=useState(false);
  const[showProfile,setShowProfile]=useState(false);
  const[showHelp,setShowHelp]=useState(false);const[helpTab,setHelpTab]=useState("help");
  const[showFeedback,setShowFeedback]=useState(false);
  const[showStorage,setShowStorage]=useState(false);
  const[showDrawings,setShowDrawings]=useState(false);
  const[showDrawingsCompare,setShowDrawingsCompare]=useState(false);
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
    DB.init(typeof PB_URL!=='undefined'?PB_URL:'https://siteshrimp.duckdns.org').then(()=>{
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
      await DB.defects.create(gd);
    }else if(storageCfg.mode==="local"&&storageCfg.localPath){
      await DB.addDefect(companyId,{...data,storageMode:"local",storagePath:storageCfg.localPath});
    }else{
      await DB.addDefect(companyId,data);
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
      await uploadDefect(data,company.companyId);

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
        {memberLoading?<><Spin size={24}/><div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginTop:12}}>Loading workspace...</div></>:(
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
    if(n.id==="admin"&&!isAdmin)return false;
    return true;
  });

  return(
    <div style={{width:"100%",maxWidth:430,margin:"0 auto",height:"100dvh",background:"#f0ede8",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* Header */}
        <div style={{background:"#1a1a1a",padding:"10px 12px 8px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
          <button onClick={()=>setShowProjects(true)} style={{background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0,flex:1,minWidth:0,maxWidth:"calc(100% - 214px)"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:8.5,fontWeight:700,color:"#ff6b00",letterSpacing:"0.13em",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{company.companyName}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:13.5,fontWeight:800,color:"#fff",marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {currentProject?.name||"SELECT PROJECT"} <span style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>▼</span>
          </div>
        </button>
          <div style={{display:"flex",alignItems:"center",gap:3,flexWrap:"nowrap",justifyContent:"flex-end",flexShrink:0}}>
          {queueCount>0&&(
              <button onClick={syncQueue} title="Queued offline entries" style={{position:"relative",width:26,height:26,borderRadius:8,background:"rgba(255,149,0,0.2)",border:"1px solid rgba(255,149,0,0.4)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,flexShrink:0}}>
                {syncing2?<Spin size={9}/>:<span style={{fontSize:11}}>📤</span>}
                <span style={{position:"absolute",top:-5,right:-4,minWidth:14,height:14,borderRadius:999,background:"#ff9500",color:"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:9,lineHeight:"14px",padding:"0 3px",textAlign:"center"}}>{queueCount}</span>
            </button>
          )}
          <button onClick={()=>{setShowAiSearch(true);setTab("defects");setShowHeaderMenu(false);}} title="AI Search" style={{width:26,height:26,borderRadius:8,background:"rgba(255,107,0,0.15)",border:"1px solid rgba(255,107,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,flexShrink:0}}>💬</button>
          <button onClick={()=>{setShowGemini(true);setShowHeaderMenu(false);}} title="AI Setup" style={{width:26,height:26,borderRadius:8,background:aiEnabled?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${aiEnabled?"rgba(255,107,0,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,flexShrink:0}}>🤖</button>
          <button onClick={()=>setShowTg(true)} title="Telegram" style={{width:26,height:26,borderRadius:8,background:tgEnabled?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${tgEnabled?"rgba(255,107,0,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21.5 4.5L2.5 11.5L9 13.5L11 20.5L15 15.5L20 18.5L21.5 4.5Z" stroke={tgEnabled?"#ff6b00":"rgba(255,255,255,0.4)"} strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </button>
          <div style={{position:"relative"}}>
            <button onClick={()=>setShowHeaderMenu(!showHeaderMenu)} title="More" style={{width:26,height:26,borderRadius:8,background:showHeaderMenu?"rgba(255,107,0,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${showHeaderMenu?"rgba(255,107,0,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:14,color:showHeaderMenu?"#ff6b00":"rgba(255,255,255,0.65)",flexShrink:0}}>⋯</button>
            {showHeaderMenu&&<div style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#2a2a2a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,overflow:"hidden",zIndex:100,minWidth:170}}>
              <button onClick={()=>{setShowStorage(true);setShowHeaderMenu(false);}} style={{width:"100%",textAlign:"left",padding:"8px 12px",background:"none",border:"none",cursor:"pointer",color:"#fff",fontSize:13,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>Storage Settings</button>
              {isAdmin&&<button onClick={()=>{setShowUsers(true);setShowHeaderMenu(false);}} style={{width:"100%",textAlign:"left",padding:"8px 12px",background:"none",border:"none",cursor:"pointer",color:"#fff",fontSize:13,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>Team Management</button>}
              <button onClick={()=>{setShowHelp(true);setShowHeaderMenu(false);}} style={{width:"100%",textAlign:"left",padding:"8px 12px",background:"none",border:"none",cursor:"pointer",color:"#fff",fontSize:13,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>Help</button>
              <button onClick={()=>{setShowFeedback(true);setFbSent(false);setFbText("");setShowHeaderMenu(false);}} style={{width:"100%",textAlign:"left",padding:"8px 12px",background:"none",border:"none",cursor:"pointer",color:"#fff",fontSize:13}}>Feedback</button>
            </div>}
          </div>
          <button onClick={()=>setShowProfile(!showProfile)} style={{width:26,height:26,borderRadius:"50%",background:"#ff6b00",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:11,color:"#fff",flexShrink:0}}>
            {(member?.name||"?")[0].toUpperCase()}
          </button>
        </div>
      </div>

      {/* Profile panel */}
      {showProfile&&<ProfilePanel member={member} authUser={authUser} company={company} onClose={()=>setShowProfile(false)} onEmailSettings={()=>{setShowEmail(true);setShowProfile(false);}} onSignOut={signOut}/>}

      {/* Main content */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:72}}>
        {tab==="dashboard"&&<Dashboard defects={defects} onView={setViewing} tgEnabled={tgEnabled} aiEnabled={aiEnabled} syncing={syncing} company={company} currentProject={currentProject} member={member} onDrawings={()=>setShowDrawings(true)} queueCount={queueCount} onSyncQueue={syncQueue} syncing2={syncing2}/>}
        {tab==="log"&&canLog&&<LogDefect member={member} company={company} currentProject={currentProject} members={members} onSave={addDefect} existingDefects={defects}/>}
        {tab==="log"&&!canLog&&<div style={{padding:40,textAlign:"center",color:"rgba(0,0,0,0.4)",fontSize:14}}>Viewer access — defect logging disabled</div>}
        {tab==="defects"&&<DefectsList defects={defects} onView={setViewing} nlFilters={nlFilters} onClearNl={()=>setNlFilters(null)}/>}
        {tab==="report"&&<Report defects={defects} onEmailSetup={()=>setShowEmail(true)} currentProject={currentProject} company={company}/>}
        {tab==="admin"&&isAdmin&&<AdminAnalytics defects={defects} members={members} company={company} currentProject={currentProject} projects={projects}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#1a1a1a",borderTop:"1px solid rgba(255,255,255,0.06)",display:"flex",padding:"8px 0 12px",zIndex:50}}>
        {navItems.map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"4px 0"}}>
            <div style={{fontSize:n.id==="log"?22:18,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.55)",fontWeight:700,lineHeight:1,fontFamily:n.id==="log"?"'Barlow Condensed',sans-serif":"inherit"}}>{n.icon}</div>
            <div style={{fontSize:9,fontWeight:700,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em"}}>{n.label.toUpperCase()}</div>
          </button>
        ))}
      </div>

      {/* Overlays */}
      {showAiSearch&&<AiSearch defects={defects} onClose={()=>setShowAiSearch(false)} onApplyFilters={f=>{setNlFilters(f);setTab("defects");}}/>}
      {viewing&&<DefectDetail defect={viewing} onClose={()=>setViewing(null)} onUpdate={updateDefect} member={member} company={company}/>}
      {showHelp&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"#1a1a1a",overflowY:"auto"}}>
          <div style={{maxWidth:430,margin:"0 auto",padding:"0 0 40px"}}>
            <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:1}}>
              <button onClick={()=>setShowHelp(false)} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
              <div style={{display:"flex",gap:0,flex:1}}>
                <button onClick={()=>setHelpTab("help")} style={{flex:1,padding:"8px 0",background:"none",border:"none",borderBottom:helpTab==="help"?"2px solid #ff6b00":"2px solid transparent",color:helpTab==="help"?"#fff":"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>HELP</button>
                <button onClick={()=>setHelpTab("features")} style={{flex:1,padding:"8px 0",background:"none",border:"none",borderBottom:helpTab==="features"?"2px solid #ff6b00":"2px solid transparent",color:helpTab==="features"?"#fff":"rgba(255,255,255,0.4)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>FEATURES</button>
              </div>
            </div>
            <div style={{padding:"20px 16px"}}>

              {/* ── HELP TAB ── */}
              {helpTab==="help"&&(
                <div>
                  {[
                    ["The Problem",[
                      ["","Construction site management remains fragmented. Defects, site inspections, safety checks, and progress updates are often tracked across disconnected tools, creating lost records, delayed action, and unnecessary reporting effort."],
                    ]],
                    ["What SiteShrimp Does",[
                      ["","SiteShrimp helps teams manage defects, inspections, progress updates, safety audits, and site feedback in one place. It makes site reporting faster, clearer, and more accountable with photos, voice input, and AI-assisted workflows."],
                    ]],
                    ["First-Time Setup",[
                      ["","1. Sign up and create your company."],
                      ["","2. Connect AI and Telegram from the header."],
                      ["","3. Invite your team in Team Management (Admin only)."],
                      ["","4. Create or select a project before logging entries."],
                    ]],
                    ["Main Navigation",[
                      ["Dashboard","View active items, status counts, severity summary, alerts, and recent entries."],
                      ["Log (+)","Create a new entry with photos, voice input, and AI-assisted filling."],
                      ["Defects","Browse, search, and filter entries by keyword, location, assignee, status, severity, or type."],
                      ["Report","Review charts, filtered statistics, and export or email reports."],
                      ["Admin","Manage analytics, projects, team settings, and system controls (Admin only)."],
                    ]],
                    ["Logging an Entry",[
                      ["","1. Choose an entry type such as Defect, Observation, Instruction, or Update."],
                      ["","2. Add or capture photos on site."],
                      ["","3. Use AI analysis to suggest the title, severity, description, trade, and assignee."],
                      ["","4. Fill in component, issue, and location details."],
                      ["","5. Submit the entry, or continue in batch mode if logging multiple items in the same area."],
                    ]],
                    ["Drawings",[
                      ["","Open Floor Plans & Drawings from the Dashboard to upload or view drawings. You can place pins on plans, link them to existing entries, create entries directly from a drawing, and use the heatmap to spot problem areas quickly."],
                    ]],
                    ["Entry Status Flow",[
                      ["Open","New item logged and awaiting action."],
                      ["In Progress","Work has started on this item."],
                      ["Done","Work has been completed and is pending review."],
                      ["Verified","The item has been checked and confirmed."],
                      ["Closed","The item is fully resolved and archived."],
                    ]],
                    ["Header Tools",[
                      ["Project selector","Switch between projects or create a new one."],
                      ["Active count","Shows how many items are still active."],
                      ["AI Search","Search in natural language, such as 'show critical plumbing in Block A'."],
                      ["AI Setup","Connect and configure your preferred AI provider."],
                      ["Telegram","Receive notifications when items are logged or updated."],
                      ["Storage","Choose where photos and files are stored."],
                      ["Team","Invite members and manage roles."],
                      ["Help","Open this guide."],
                      ["Feedback","Send suggestions or report bugs."],
                      ["Profile","Manage your account settings and sign out."],
                    ]],
                    ["Practical Tips",[
                      ["Offline use","You can continue logging entries while offline and sync them later when you reconnect."],
                      ["Multiple projects","Use the project selector to switch between project workspaces."],
                      ["CSV export","Use the Report tab to download filtered data for sharing or analysis."],
                      ["Voice input","Use the mic button in supported fields to speak instead of typing."],
                      ["Batch logging","If you are logging several issues in the same area, reuse the same location to work faster."],
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

              {/* ── FEATURES TAB ── */}
              {helpTab==="features"&&(
                <div>
                  {(()=>{const fc=[
                    ["Auth & Onboarding",["Login / Sign up","Password reset","Password visibility toggle","One-step registration + company setup","Auto-recover session","Install as app","Server URL config"]],
                    ["Team",["Invite members (link + code)","Role-based access (Admin, Manager, Inspector, Viewer)","Edit roles / remove members","Permission matrix display"]],
                    ["Projects",["Create / rename projects","Switch active project","Archive / restore projects"]],
                    ["Entry Logging",["Log with title, severity, location","4 default types + custom entry types","Custom type manager (icon & color picker)","Multi-level location (Level > Zone > Room > Grid)","Snap / upload up to 10 photos","Photo markup editor (arrows, circles, freehand, text)","AI photo analysis (Gemini, Ollama, GPT)","AI auto-assign trade + suggested assignee","AI safety risk scoring (auto-escalate Critical)","Duplicate detection (similarity check on submit)","Voice-to-text input (title, description, search)","Component + issue selector (93 / 517)","Assign to team member","Cost & time tracking fields","Batch logging mode (same location)"]],
                    ["Entry Management",["Full-text search with highlighting","AI natural language search (voice + text)","Filter by status, severity, entry type","Collapsible filters with clear button","Entry type badges on list & detail","Detail view with all fields + photos","Update status workflow (5 stages)","Verification photo on Close / Verify","Before / after photo comparison slider","Resolution timeline (visual, color-coded)","Photo comments in timeline","Quick reactions (thumbs, check, warn, fix)","Delete entry (Admin only)","Telegram alerts on new entry & status change"]],
                    ["Drawings & Floor Plans",["Upload floor plans (JPG, PNG, TIF, PDF)","PDF rendering via PDF.js with page navigation","Zoom, pan & pinch-to-zoom (mobile)","Ring-style defect pins with severity initial","Critical pin pulse animation","Pin tooltip with entry details + remove","Quick-pin: create entry directly from drawing","Defect heatmap overlay (severity-weighted)","Drawing-level markup (freehand, arrows, circles)","Markup color picker + undo / clear","Pin count & severity badges on cards","PDF thumbnail preview in list"]],
                    ["Dashboard",["Real-time status counts (5 stages)","Critical alerts banner","Severity breakdown chart","Recent entries with type badges","Live sync indicator + queue count"]],
                    ["Admin Analytics",["Entries today / week / month / all time","Active users — who submitted today & this week","Per-user ranking bar chart","Photos stats (total & avg per entry)","Entries by entry type breakdown","Entries by project breakdown","AI usage stats (daily limit, coverage, provider)"]],
                    ["Reports",["Site report with charts + entry list","Filter by severity / status / assignee / date","CSV export","Email report via EmailJS"]],
                    ["Storage",["PocketBase (default server)","Local path (self-hosted server / machine)","Google Drive (OAuth, personal cloud)"]],
                    ["Settings",["Telegram bot setup + test","AI multi-provider setup + test","Email report config","Daily AI usage limit","Storage mode selector"]],
                    ["Offline",["Save entries to IndexedDB when offline","Queued badge in header + Dashboard","Auto-sync when back online","Manual sync tap","Queued / synced status indicator"]],
                    ["Account",["Edit display name + job title","Change email","Change password"]],
                    ["Other",["Comprehensive help guide","Feedback form (suggestion, bug, praise)","Cached app shell (service worker)","Photo compression (auto-resize)"]],
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
                <div style={{fontSize:11,color:"rgba(255,255,255,0.2)",fontFamily:"'Barlow Condensed',sans-serif"}}>SiteShrimp v2 — Built for teams that deliver</div>
                <button onClick={()=>setShowHelp(false)} style={{marginTop:16,background:"#ff6b00",border:"none",borderRadius:10,padding:"12px 32px",color:"#fff",fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>GOT IT</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showFeedback&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a1a1a",borderRadius:16,padding:24,width:"100%",maxWidth:400,animation:"fadeIn 0.15s ease"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#fff",marginBottom:4}}>FEEDBACK</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:20,lineHeight:1.5}}>Help us improve SiteShrimp! Share your thoughts on the design, usability, or features. What works well? What feels confusing? Any ideas for improvement?</div>
            {fbSent?(
              <div style={{textAlign:"center",padding:"20px 0"}}>
                <div style={{fontSize:28,marginBottom:10}}>✓</div>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:700,color:"#00e564",marginBottom:6}}>THANK YOU!</div>
                <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:20}}>Your feedback has been recorded. We read every submission.</div>
                <button onClick={()=>setShowFeedback(false)} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"12px 32px",color:"#fff",fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>DONE</button>
              </div>
            ):(
              <>
                <div style={{display:"flex",gap:6,marginBottom:14}}>
                  {[["suggestion","Suggestion"],["bug","Bug Report"],["praise","What I Like"],["other","Other"]].map(([id,label])=>(
                    <button key={id} onClick={()=>setFbType(id)} style={{flex:1,padding:"8px 4px",borderRadius:8,border:`1.5px solid ${fbType===id?"#ff6b00":"rgba(255,255,255,0.1)"}`,background:fbType===id?"rgba(255,107,0,0.15)":"rgba(255,255,255,0.05)",color:fbType===id?"#ff6b00":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>{label}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:16}}>
                  <textarea value={fbText} onChange={e=>setFbText(e.target.value)} placeholder="Type your feedback here... What would make this app better for your team?" rows={4} style={{flex:1,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"12px",color:"#fff",fontSize:14,resize:"none",fontFamily:"'Barlow',sans-serif"}}/>
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
                  {fbSending?<Spin size={16}/>:null}{fbSending?"SENDING...":"SUBMIT FEEDBACK"}
                </button>
                <button onClick={()=>setShowFeedback(false)} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:12,cursor:"pointer",padding:"12px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
      {showTg&&<TelegramSettings onClose={()=>setShowTg(false)} companyId={company?.companyId}/>}
      {showEmail&&<EmailSettings onClose={()=>setShowEmail(false)} companyId={company?.companyId}/>}
      {showGemini&&<GeminiSettings onClose={()=>setShowGemini(false)} companyId={company?.companyId}/>}
      {showStorage&&<StorageSettings onClose={()=>setShowStorage(false)} companyId={company?.companyId}/>}
      {showDrawings&&<DrawingsPanel onClose={()=>{setShowDrawings(false);setShowDrawingsCompare(false);}} company={company} currentProject={currentProject} member={member} defects={defects} onSaveEntry={addDefect} initialCompare={showDrawingsCompare}/>}
      {showUsers&&<UserManagement onClose={()=>setShowUsers(false)} company={company} member={member} members={members}/>}
      {showProjects&&<ProjectManagement onClose={()=>setShowProjects(false)} company={company} member={member} projects={projects} currentProject={currentProject} onSelect={p=>{selectProject(p);setShowProjects(false);}}/>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

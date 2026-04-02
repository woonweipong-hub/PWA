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
function compressPhoto(dataUrl,maxPx=1200,quality=0.7){
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

async function analyzeWithGemini(apiKey,base64Image){
  try{
    const b64=base64Image.split(",")[1];
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[
        {inline_data:{mime_type:"image/jpeg",data:b64}},
        {text:'Analyze this construction defect photo. Respond in valid JSON only, no markdown: {"title":"max 5 word defect title","severity":"one of Critical Major Minor Observation","description":"2 sentence technical description"}'}
      ]}]})
    });
    const data=await res.json();
    const text=data.candidates?.[0]?.content?.parts?.[0]?.text||"{}";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  }catch{return null;}
}

function exportCSV(defects,projectName){
  const headers=["ID","Title","Location","Severity","Status","Assignee","Logged By","Date","Description","Comments"];
  const rows=defects.map((d,i)=>[
    `DEF-${String(i+1).padStart(4,"0")}`,
    `"${(d.title||"").replace(/"/g,'""')}"`,
    `"${(d.location||"").replace(/"/g,'""')}"`,
    d.severity||"",d.status||"",d.assignee||"",d.loggedBy||"",
    d.created?new Date(d.created).toLocaleDateString("en-GB"):"",
    `"${(d.description||"").replace(/"/g,'""')}"`,
    `"${(d.comments||[]).map(c=>`${c.by}: ${c.text}`).join(" | ")}"`
  ].join(","));
  const csv=[headers.join(","),...rows].join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
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
  const date=new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
  const defectRows=defects.map(d=>{
    const dt=d.created?new Date(d.created).toLocaleDateString("en-GB"):"—";
    const comments=(d.comments||[]).map(c=>`<div style="padding:6px 10px;background:#f5f5f5;border-radius:6px;font-size:12px;margin:4px 0"><b style="color:#ff6b00">${c.by}:</b> ${c.text}</div>`).join("");
    // Photos excluded from email — base64 exceeds EmailJS 50KB free tier limit
    const photo=d.photo?`<div style="font-size:11px;color:#888;font-style:italic;margin-top:6px;padding:6px 8px;background:#f5f5f5;border-radius:6px">📷 Photo available in SiteShrimp app</div>`:"";

    return `<div style="margin-bottom:14px;padding:14px;border:1px solid #e5e5e5;border-radius:10px;border-left:5px solid ${SEV_COLOR[d.severity]}">
      <div style="font-size:15px;font-weight:bold;margin-bottom:6px">${d.title}</div>
      <table style="font-size:12px;color:#555;margin-bottom:6px"><tbody>
        <tr><td style="padding:2px 8px 2px 0;color:#999">Location</td><td>${d.location}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#999">Assigned</td><td>${d.assignee}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#999">Severity</td><td style="color:${SEV_COLOR[d.severity]};font-weight:bold">${d.severity}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#999">Status</td><td>${d.status}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#999">Date</td><td>${dt}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#999">By</td><td>${d.loggedBy||"—"}</td></tr>
      </tbody></table>
      ${d.description?`<div style="font-size:13px;color:#444;padding:8px;background:#f9f9f9;border-radius:6px;margin-bottom:6px">${d.description}</div>`:""}
      ${photo}
      ${comments?`<div style="margin-top:8px"><div style="font-size:10px;font-weight:bold;color:#999;margin-bottom:4px">COMMENTS</div>${comments}</div>`:""}
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
        <td><div style="font-size:30px;font-weight:bold">${total}</div><div style="font-size:10px;color:#999">TOTAL</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#ff3b30">${open}</div><div style="font-size:10px;color:#999">OPEN</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#ff9500">${inProg}</div><div style="font-size:10px;color:#999">IN PROG</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#34aadc">${done}</div><div style="font-size:10px;color:#999">DONE</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#30d158">${verified}</div><div style="font-size:10px;color:#999">VERIFIED</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#8e8e93">${closed}</div><div style="font-size:10px;color:#999">CLOSED</div></td>
      </tr></table>
    </div>
    <div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:12px">ALL ENTRIES</div>
      ${defectRows||'<div style="color:#999;text-align:center;padding:16px">No defects found.</div>'}
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
  const[err,setErr]=useState("");const[loading,setLoading]=useState(false);const[step,setStep]=useState("");
  const[installable,setInstallable]=useState(!!_deferredInstallPrompt);
  const inv=new URLSearchParams(window.location.search).get("invite")||"";

  useEffect(()=>{if(inv){setPage("auth");setMode("register");setShowInvite(true);setCode(inv);}},[]);

  useEffect(()=>{
    const check=()=>setInstallable(!!_deferredInstallPrompt);
    window.addEventListener("beforeinstallprompt",check);
    return()=>window.removeEventListener("beforeinstallprompt",check);
  },[]);

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
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28,textAlign:"center"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <img src="icons/icon-192.png" alt="SiteShrimp" style={{width:80,height:80,borderRadius:8,marginBottom:16,boxShadow:"0 4px 20px rgba(255,107,0,0.3)"}}/>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:42,fontWeight:800,color:"#fff",lineHeight:1,marginBottom:8}}>SITESHRIMP</div>
        <div style={{color:"rgba(255,255,255,0.5)",fontSize:14,marginBottom:32,lineHeight:1.6}}>
          Construction site works, defects and items<br/>tracking and monitoring for teams that deliver.
        </div>

        <div style={{textAlign:"left",marginBottom:32}}>
          {[
            ["📷","Snap photos, AI describes the defect"],
            ["mic","Voice support — hands-free feature"],
            ["📋","Paperless Defects Tracking, Site Monitoring and Instant Feedbacks"],
            ["👥","Team sync, live updates"],
            ["📊","Real Time Visual Dashboard Reports"],
            ["🔔","Telegram-linked, CSV Export and Email Summary"],
          ].map(([icon,text],i)=>(
            <div key={i} className="anim" style={{animationDelay:`${i*0.08}s`,display:"flex",gap:12,alignItems:"center",padding:"10px 0",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
              <div style={{width:32,textAlign:"center",flexShrink:0}}>
                {icon==="mic"
                  ?<svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{display:"inline-block"}}>
                    <rect x="9" y="2" width="6" height="12" rx="3" fill="#ff6b00"/>
                    <path d="M5 10a7 7 0 0014 0" stroke="#ff6b00" strokeWidth="2" strokeLinecap="round"/>
                    <line x1="12" y1="19" x2="12" y2="22" stroke="#ff6b00" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  :<span style={{fontSize:20}}>{icon}</span>
                }
              </div>
              <div style={{color:"rgba(255,255,255,0.7)",fontSize:14}}>{text}</div>
            </div>
          ))}
        </div>

        <button onClick={()=>setPage("auth")} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:12,padding:"16px",color:"#fff",fontSize:16,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:12,letterSpacing:"0.04em"}}>GET STARTED</button>

        <button onClick={installable?installApp:()=>alert("To install:\n\nAndroid: Menu (⋮) → Add to Home Screen\n\niPhone: Share (↑) → Add to Home Screen")} style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:12,padding:"14px",color:"rgba(255,255,255,0.8)",fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round"/></svg>
          INSTALL APP
        </button>

        <div style={{color:"rgba(255,255,255,0.15)",fontSize:11,marginTop:20,marginBottom:40,fontFamily:"'Barlow Condensed',sans-serif"}}>
          Free for all teams · No app store needed
        </div>

        {/* Feature Status Checklist */}
        <div style={{textAlign:"left"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",marginBottom:16}}>ALL FEATURES ({[
            ["Auth & Onboarding",["Login / Sign up","Password reset","One-step registration + company setup","Auto-recover session","Install as app","Server URL config"]],
            ["Team",["Invite members (link + code)","Role-based access (Admin, Manager, Inspector, Viewer)","Edit roles / remove members","Permission matrix"]],
            ["Projects",["Create / rename projects","Switch active project","Archive / restore projects"]],
            ["Defect Logging",["Log defect with title, severity, location","Multi-level location (Level > Zone > Room > Grid)","Snap or upload up to 5 photos","AI photo analysis (Gemini)","Voice-to-text (title, description)","Component + issue selector","Assign to team member","Cost & time tracking fields","Batch logging (same location)"]],
            ["Defect Management",["View all entries with status/severity filters","Defect detail view with photos","Update status (Open > In Progress > Done > Verified > Closed)","Add comments (text + voice)","Delete defect (Admin only)","Telegram alerts on status change"]],
            ["Dashboard",["Real-time stats (Open / In Progress / Done)","Critical defect alerts","Severity breakdown chart","Recent defects feed","Live sync indicator"]],
            ["Reports",["Site report with charts + defect list","Filter by severity / status / assignee / date","CSV export","Email report (EmailJS)"]],
            ["Settings",["Telegram bot setup + test","Gemini AI setup + test","Email report setup","Daily AI usage limit"]],
            ["Profile",["View profile info","Sign out with credential cleanup"]],
          ].reduce((n,g)=>n+g[1].length,0)} features)</div>
          {[
            ["Auth & Onboarding",[["Login / Sign up",true],["Password reset",true],["One-step registration + company setup",true],["Auto-recover session",true],["Install as app",true],["Server URL config",true]]],
            ["Team",[["Invite members (link + code)",true],["Role-based access control",true],["Edit roles / remove members",true],["Permission matrix display",true]]],
            ["Projects",[["Create / rename projects",true],["Switch active project",true],["Archive / restore projects",true]]],
            ["Defect Logging",[["Log with title, severity, location",true],["Multi-level location hierarchy",true],["Snap / upload up to 5 photos",true],["AI photo analysis (Gemini)",true],["Voice-to-text input",true],["Component + issue selector",true],["Assign to team member",true],["Cost & time tracking fields",true],["Batch logging mode",true]]],
            ["Defect Management",[["Status & severity filters",true],["Full detail view with photos",true],["Update status workflow",true],["Comments (text + voice)",true],["Delete defect (Admin)",true],["Telegram alerts",true]]],
            ["Dashboard",[["Real-time stats overview",true],["Critical defect alerts",true],["Severity breakdown chart",true],["Recent defects feed",true],["Live sync indicator",true]]],
            ["Reports",[["Site report with charts",true],["Filter by severity / status / assignee / date",true],["CSV export",true],["Email report (EmailJS)",true]]],
            ["Settings",[["Telegram bot setup + test",true],["Gemini AI setup + test",true],["Email report config",true],["Daily AI usage limit",true]]],
            ["Coming Soon",[["Drawings / floor plan pins",false],["Profile editing",false],["Search across defects",false],["Offline mode",false],["Push notifications",false]]],
          ].map(([cat,items])=>(
            <div key={cat} style={{marginBottom:16}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"#ff6b00",letterSpacing:"0.08em",marginBottom:6}}>{cat.toUpperCase()}</div>
              {items.map(([feat,done])=>(
                <div key={feat} style={{display:"flex",gap:8,alignItems:"center",padding:"4px 0",fontSize:12,color:done?"rgba(255,255,255,0.5)":"rgba(255,255,255,0.2)"}}>
                  <span style={{fontSize:10,flexShrink:0,width:16,textAlign:"center"}}>{done?"✓":"○"}</span>
                  <span>{feat}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ── Login / Register page (consolidated) ──
  return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:28}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={()=>setPage("intro")} style={{background:"rgba(255,255,255,0.07)",border:"none",borderRadius:20,padding:"6px 12px",color:"rgba(255,255,255,0.5)",fontSize:12,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>←</button>
          <div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#fff",lineHeight:1}}>SITESHRIMP</div>
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:12}}>Construction Site Tracker</div>
          </div>
        </div>

        {/* Mode tabs */}
        <div style={{display:"flex",gap:8,marginBottom:20}}>
          {["login","register"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");setStep("");}} style={{flex:1,background:mode===m?"#ff6b00":"rgba(255,255,255,0.07)",border:"none",borderRadius:10,padding:"11px",color:mode===m?"#fff":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{m==="login"?"LOGIN":"SIGN UP"}</button>
          ))}
        </div>

        {mode==="register"&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>NAME</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={darkInp}/></div>}
        <div style={{marginBottom:12}}><label style={lbl("#fff")}>EMAIL</label><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" type="email" style={darkInp}/></div>
        <div style={{marginBottom:mode==="register"?12:16}}><label style={lbl("#fff")}>PASSWORD</label><input value={pw} onChange={e=>setPw(e.target.value)} placeholder={mode==="register"?"Min 8 characters":"Password"} type="password" style={darkInp}/></div>
        {mode==="register"&&!showInvite&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>COMPANY NAME</label><input value={cName} onChange={e=>setCName(e.target.value)} placeholder="Your company or organisation" style={darkInp}/></div>}
        {mode==="register"&&showInvite&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>INVITE CODE</label><input value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste invite code from your admin" style={darkInp}/></div>}
        {mode==="register"&&!inv&&<button onClick={()=>{setShowInvite(!showInvite);setErr("");}} style={{background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:11,cursor:"pointer",padding:"0 0 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700}}>{showInvite?"← Creating a new company":"Have an invite code?"}</button>}

        {err&&<div style={{background:err.startsWith("Reset")?"rgba(0,229,100,0.1)":"rgba(255,59,48,0.12)",border:`1px solid ${err.startsWith("Reset")?"rgba(0,229,100,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"10px 14px",marginBottom:14,color:err.startsWith("Reset")?"#00e564":"#ff6b6b",fontSize:13,whiteSpace:"pre-line"}}>{err}</div>}

        <button onClick={submit} disabled={loading} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10,opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          {loading?<Spin size={16}/>:null}{loading?(step||"..."):(mode==="login"?"LOGIN":"GET STARTED")}
        </button>

        {mode==="login"&&<button onClick={resetPw} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:13,cursor:"pointer",padding:"8px"}}>Forgot password?</button>}

        <ServerUrlConfig/>

        {installable&&(
          <button onClick={installApp} style={{width:"100%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"12px",color:"rgba(255,255,255,0.5)",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginTop:8,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span style={{fontSize:15}}>+</span> INSTALL AS APP
          </button>
        )}
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

// ── Gemini AI Settings ────────────────────────────────────────────
function GeminiSettings({onClose,companyId}){
  const[key,setKey]=useState(()=>local.get(GEMINI_KEY)||"");
  const[saved,setSaved]=useState(false);const[testing,setTesting]=useState(false);const[testRes,setTestRes]=useState(null);
  const save=()=>{local.set(GEMINI_KEY,key.trim());saveSettingToFirestore(companyId,"gemini",key.trim());setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const test=async()=>{
    setTesting(true);setTestRes(null);
    try{
      const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key.trim()}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:"Reply with just: OK"}]}]})});
      setTestRes(res.ok?"success":"fail");
    }catch{setTestRes("fail");}
    setTesting(false);
  };
  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:200,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <SettingsBack onClose={onClose} title="🤖 AI PHOTO ANALYSIS"/>
      <div style={{padding:20}}>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:20}}>
          {[["1","Go to aistudio.google.com and sign in with Google"],["2","Click Get API Key → Create API Key"],["3","Copy the key and paste below → Test → Save"]].map(([n,t])=>(
            <div key={n} style={{display:"flex",gap:10,marginBottom:10,alignItems:"flex-start"}}>
              <div style={{width:22,height:22,borderRadius:"50%",background:"#ff6b00",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:12,color:"#fff"}}>{n}</div>
              <div style={{fontSize:13,color:"#444",lineHeight:1.5,paddingTop:2}}>{t}</div>
            </div>
          ))}
          <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:8,padding:"10px 12px",marginTop:8}}>
            <div style={{fontSize:12,color:"#1a7a35",fontWeight:600}}>✓ Free — 1,500 photo analyses per day · No credit card</div>
          </div>
        </div>
        <div style={{marginBottom:20}}><label style={lbl()}>GEMINI API KEY</label><input value={key} onChange={e=>setKey(e.target.value)} placeholder="AIzaSy..." type="password" style={{...inp,width:"100%",flex:"unset"}}/></div>
        {testRes&&<div style={{background:testRes==="success"?"rgba(48,209,88,0.1)":"rgba(255,59,48,0.1)",border:`1px solid ${testRes==="success"?"rgba(48,209,88,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"12px 16px",marginBottom:16,color:testRes==="success"?"#1a7a35":"#cc0000",fontSize:13,fontWeight:600}}>{testRes==="success"?"✓ AI connected! Photos will be auto-analyzed.":"✗ Invalid key. Check and try again."}</div>}
        <div style={{display:"flex",gap:10}}>
          <button onClick={test} disabled={!key||testing} style={{flex:1,background:"rgba(0,0,0,0.06)",border:"1px solid rgba(0,0,0,0.12)",borderRadius:10,padding:13,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{testing?"TESTING...":"TEST"}</button>
          <button onClick={save} disabled={!key} style={{flex:2,background:key?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:10,padding:13,color:key?"#fff":"rgba(0,0,0,0.3)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,cursor:"pointer"}}>{saved?"✓ SAVED":"SAVE"}</button>
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

// ── Dashboard ─────────────────────────────────────────────────────
function Dashboard({defects,onView,tgEnabled,aiEnabled,syncing,company,currentProject,member}){
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

      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,color:"rgba(0,0,0,0.4)",letterSpacing:"0.1em",marginBottom:10}}>RECENT DEFECTS</div>
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
function LogDefect({member,company,currentProject,members,onSave}){
  const blank={title:"",location:"",severity:"Major",description:"",assignee:member?.name||"",photos:[],
    component:"",issue:"",locationLevel:"",locationZone:"",locationSubzone:"",locationGrid:"",
    entryType:"Defect",dueDate:"",duration:"",costImpact:"",costResponsible:"",costAmount:"",costRemarks:""};
  const[form,setForm]=useState(blank);
  const[showMore,setShowMore]=useState(false);
  const[saving,setSaving]=useState(false);const[analyzing,setAnalyzing]=useState(false);const[aiResult,setAiResult]=useState(null);
  const[count,setCount]=useState(0);const[last,setLast]=useState(null);const[showBatch,setShowBatch]=useState(false);
  const fileRef=useRef();
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const geminiKey=local.get(GEMINI_KEY);
  const assignees=members.length>0?members.map(m=>m.name):["Site Manager","Engineer","Contractor","QC Inspector","Safety Officer"];
  const MAX_PHOTOS=5;

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
    if(!form.photos.length||!geminiKey)return;
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
      const result=await analyzeWithGemini(geminiKey,compressed||form.photos[0]);
      if(result){
        local.set(AI_LIMIT_KEY,{date:today,count:todayCount+1});
        setAiResult(result);
        if(result.title)set("title",result.title);
        if(result.severity&&SEVERITY.includes(result.severity))set("severity",result.severity);
        if(result.description)set("description",result.description);
      }else{
        alert("AI could not analyze the photo. Try a clearer image or log manually.");
      }
    }catch(e){alert("AI analysis error: "+e.message);}
    setAnalyzing(false);
  };

  const submit=async()=>{
    if(!form.title.trim())return;
    // Build location display from hierarchy
    const locParts=[form.locationLevel,form.locationZone,form.locationSubzone,form.locationGrid].filter(Boolean);
    const locationDisplay=locParts.join(" > ")||form.location||"";
    if(!locationDisplay&&!form.location){alert("Please select a location.");return;}
    setSaving(true);
    try{
      const compressed=[];
      for(const p of form.photos){
        const c=await compressPhoto(p);
        if(c)compressed.push(c);
      }
      const trade=COMPONENT_TRADE[form.component]||"";
      await onSave({
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
        locationLevel:form.locationLevel,locationZone:form.locationZone,component:form.component});
      setCount(c=>c+1);setShowBatch(true);setForm(blank);setAiResult(null);setShowMore(false);
    }catch(e){alert("Error saving: "+e.message);}
    setSaving(false);
  };

  if(showBatch)return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.3)",borderRadius:14,padding:24,textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:8}}>✓</div>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"#1a7a35",marginBottom:4}}>ENTRY LOGGED</div>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)"}}>{count} logged this session · Team notified</div>
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
          {ENTRY_TYPES.map(t=>(
            <button key={t} onClick={()=>set("entryType",t)} style={{padding:"8px 14px",borderRadius:20,border:`2px solid ${form.entryType===t?ENTRY_TYPE_COLOR[t]:"rgba(0,0,0,0.12)"}`,background:form.entryType===t?ENTRY_TYPE_BG[t]:"#fff",color:form.entryType===t?ENTRY_TYPE_COLOR[t]:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{ENTRY_TYPE_ICON[t]} {t.toUpperCase()}</button>
          ))}
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

      {/* Cost & Time — collapsible */}
      <button onClick={()=>setShowMore(!showMore)} style={{width:"100%",background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,padding:"12px",marginBottom:showMore?12:16,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",color:"rgba(0,0,0,0.5)",textAlign:"left"}}>{showMore?"▼":"▶"} COST & TIME (optional)</button>
      {showMore&&(
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
      )}

      <div style={{marginBottom:20}}>
        <label style={lbl()}>PHOTOS ({form.photos.length}/{MAX_PHOTOS})</label>
        <input type="file" accept="image/*" capture="environment" multiple ref={fileRef} onChange={handlePhoto} style={{display:"none"}}/>
        {form.photos.length>0&&(
          <div>
            <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:8}}>
              {form.photos.map((p,i)=>(
                <div key={i} style={{position:"relative",flexShrink:0}}>
                  <img src={p} alt="" style={{width:100,height:100,borderRadius:10,objectFit:"cover"}}/>
                  <button onClick={()=>removePhoto(i)} style={{position:"absolute",top:4,right:4,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",color:"#fff",width:22,height:22,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                </div>
              ))}
              {form.photos.length<MAX_PHOTOS&&(
                <button onClick={()=>fileRef.current.click()} style={{width:100,height:100,borderRadius:10,border:"2px dashed rgba(0,0,0,0.15)",background:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:24,color:"rgba(0,0,0,0.3)"}}>+</button>
              )}
            </div>
            {geminiKey&&(
              <button onClick={analyze} disabled={analyzing} style={{width:"100%",background:"rgba(88,86,214,0.08)",border:"1.5px solid rgba(88,86,214,0.3)",borderRadius:10,padding:"11px",color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {analyzing?<><Spin size={14}/><span>ANALYZING...</span></>:<><span>🤖</span><span>ANALYZE WITH AI</span></>}
              </button>
            )}
            {!geminiKey&&<div style={{fontSize:11,color:"rgba(0,0,0,0.35)",textAlign:"center",padding:"6px 0"}}>Setup AI (🤖 in header) to auto-fill from photo</div>}
            {aiResult&&(
              <div style={{background:"rgba(88,86,214,0.06)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"10px 12px",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#5856d6",marginBottom:4,fontFamily:"'Barlow Condensed',sans-serif"}}>AI FILLED — REVIEW & EDIT ABOVE</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.5)"}}>{aiResult.description}</div>
              </div>
            )}
          </div>
        )}
        {form.photos.length===0&&(
          <button onClick={()=>fileRef.current.click()} style={{width:"100%",background:"#fff",border:"2px dashed rgba(0,0,0,0.15)",borderRadius:10,padding:20,color:"rgba(0,0,0,0.4)",fontSize:14,cursor:"pointer"}}>📷 Add photos (up to {MAX_PHOTOS}){geminiKey?" · AI will auto-analyze":""}</button>
        )}
      </div>

      <button onClick={submit} disabled={saving||!form.title.trim()||(!form.locationLevel&&!form.location)} style={{width:"100%",background:form.title.trim()&&(form.locationLevel||form.location)&&!saving?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:12,padding:16,color:form.title.trim()&&(form.locationLevel||form.location)?"#fff":"rgba(0,0,0,0.3)",fontSize:16,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {saving?<><Spin size={16}/><span>SAVING...</span></>:"SUBMIT ENTRY"}
      </button>
    </div>
  );
}

// ── Defects List ──────────────────────────────────────────────────
function DefectsList({defects,onView}){
  const[filter,setFilter]=useState("All");const[sevF,setSevF]=useState("All");
  const filtered=defects.filter(d=>(filter==="All"||d.status===filter)&&(sevF==="All"||d.severity===sevF));
  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a",marginBottom:14}}>ALL DEFECTS <span style={{color:"rgba(0,0,0,0.3)",fontSize:18}}>({filtered.length})</span></div>
      <div style={{marginBottom:10}}>
        <div style={lbl()}>STATUS</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["All",...STATUS].map(s=>(
            <button key={s} onClick={()=>setFilter(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${filter===s?"#ff6b00":"rgba(0,0,0,0.12)"}`,background:filter===s?"#ff6b00":"#fff",color:filter===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s.toUpperCase()}</button>
          ))}
        </div>
      </div>
      <div style={{marginBottom:16}}>
        <div style={lbl()}>SEVERITY</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["All",...SEVERITY].map(s=>(
            <button key={s} onClick={()=>setSevF(s)} style={{padding:"6px 12px",borderRadius:20,border:`1.5px solid ${sevF===s?"#1a1a1a":"rgba(0,0,0,0.12)"}`,background:sevF===s?"#1a1a1a":"#fff",color:sevF===s?"#fff":"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {filtered.length===0&&<div style={{textAlign:"center",color:"rgba(0,0,0,0.3)",padding:"50px 0",fontSize:14}}>No defects found</div>}
      {filtered.map((d,i)=>(
        <div key={d.id} className="anim" style={{animationDelay:`${i*0.04}s`,background:"#fff",borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",borderLeft:`4px solid ${SEV_COLOR[d.severity]}`}} onClick={()=>onView(d)}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:15,color:"#1a1a1a",flex:1,paddingRight:8}}>{d.title}</div>
            <StatusChip s={d.status}/>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:4}}>
            <SevChip s={d.severity}/>
            <span style={{fontSize:11,color:"rgba(0,0,0,0.4)"}}>📍 {d.location}</span>
          </div>
          <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",display:"flex",justifyContent:"space-between"}}>
            <span>→ {d.assignee}</span>
            <span>{d.created?new Date(d.created).toLocaleDateString():"Just now"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Defect Detail ─────────────────────────────────────────────────
function DefectDetail({defect,onClose,onUpdate,member,company}){
  const[status,setStatus]=useState(defect.status);
  const[comment,setComment]=useState("");const[saving,setSaving]=useState(false);const[deleting,setDeleting]=useState(false);
  const latestRef=useRef(defect);
  useEffect(()=>{latestRef.current={...latestRef.current,...defect,status};},[defect,status]);
  const tgCfg=local.get(TG_KEY);
  const canUpdate=["Admin","Manager","Inspector"].includes(member?.role);
  const canDelete=member?.role==="Admin";

  const updateStatus=async s=>{
    if(!canUpdate)return;
    setStatus(s);
    try{
      await DB.defects.update(defect.id,{status:s});
      latestRef.current={...latestRef.current,status:s};
      onUpdate({...latestRef.current});
      if(tgCfg?.token&&tgCfg?.chatId){
        const e=STATUS_ICON[s]||"⚪";
        sendTelegram(tgCfg.token,tgCfg.chatId,`${e} <b>Status Updated</b>\n<b>${defect.title}</b>\nStatus: <b>${s}</b>\nBy: ${member?.name}`).catch(()=>{});
      }
    }catch(e){setStatus(defect.status);alert("Failed to update status: "+e.message);}
  };

  const addComment=async()=>{
    if(!comment.trim()||saving||!canUpdate)return;
    setSaving(true);
    const newComment={text:comment,by:member?.name||"",role:member?.role||"",at:Date.now()};
    const newComments=[...(latestRef.current.comments||[]),newComment];
    try{
      await DB.defects.update(defect.id,{comments:newComments});
      latestRef.current={...latestRef.current,comments:newComments};
      onUpdate({...latestRef.current});
      if(tgCfg?.token&&tgCfg?.chatId)sendTelegram(tgCfg.token,tgCfg.chatId,`💬 <b>Comment — ${defect.title}</b>\n${member?.name}: ${comment}`).catch(()=>{});
      setComment("");
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
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}><SevChip s={defect.severity}/><StatusChip s={status}/></div>
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

        {defect.photo&&(
          typeof defect.photo==="string"
            ?<img src={defect.photo} alt="" style={{width:"100%",borderRadius:12,maxHeight:250,objectFit:"cover",marginBottom:14}}/>
            :Array.isArray(defect.photo)&&defect.photo.length>0
              ?<div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:14}}>
                {defect.photo.map((p,i)=><img key={i} src={p} alt="" style={{height:180,borderRadius:12,objectFit:"cover",flexShrink:0}}/>)}
              </div>
              :null
        )}

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
          <div style={lbl()}>COMMENTS ({(defect.comments||[]).length})</div>
          {(defect.comments||[]).map((c,i)=>(
            <div key={i} style={{background:"#fff",borderRadius:10,padding:"10px 12px",marginBottom:8}}>
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:3}}>
                <span style={{fontSize:11,fontWeight:700,color:"#ff6b00",fontFamily:"'Barlow Condensed',sans-serif"}}>{c.by}</span>
                {c.role&&<RoleChip r={c.role}/>}
                <span style={{fontSize:10,color:"rgba(0,0,0,0.3)"}}>{new Date(c.at).toLocaleDateString()}</span>
              </div>
              <div style={{fontSize:13,color:"#333"}}>{c.text}</div>
            </div>
          ))}
          {canUpdate?(
            <div style={{display:"flex",gap:8,marginTop:4,alignItems:"center"}}>
              <input value={comment} onChange={e=>setComment(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addComment()} placeholder="Add a comment..." style={{...inp,flex:1}}/>
              <MicBtn onResult={t=>setComment(c=>c+(c?" ":"")+t)} append currentValue={comment}/>
              <button onClick={addComment} disabled={saving||!comment.trim()} style={{background:"#ff6b00",border:"none",borderRadius:10,padding:"11px 16px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>{saving?"...":"POST"}</button>
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

// ── App Root ──────────────────────────────────────────────────────
const NAV=[{id:"dashboard",icon:"⊞",label:"Dashboard"},{id:"log",icon:"+",label:"Log"},{id:"defects",icon:"≡",label:"Defects"},{id:"report",icon:"◎",label:"Report"}];


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
  const[showUsers,setShowUsers]=useState(false);
  const[showProjects,setShowProjects]=useState(false);
  const[showProfile,setShowProfile]=useState(false);
  const[showHelp,setShowHelp]=useState(false);
  const[showFeedback,setShowFeedback]=useState(false);
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
      // Map photo filenames to URLs (supports single string or array)
      const withPhotos=items.map(d=>{
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

  const addDefect=async data=>{
    if(!company?.companyId||!currentProject)return;

    await DB.addDefect(company.companyId,data);

    // Telegram notification (fire-and-forget, don't block on failure)
    try{
      const cfg=local.get(TG_KEY);
      if(cfg?.token&&cfg?.chatId){
        const e={Critical:"\u{1F534}",Major:"\u{1F7E0}",Minor:"\u{1F7E1}",Observation:"\u{1F535}"}[data.severity]||"\u26AA";
        const text=`${e} <b>NEW DEFECT — ${company.companyName}</b>\n\n📁 ${currentProject.name}\n📋 <b>${data.title}</b>\n📍 ${data.location}\n⚠️ ${data.severity}\n👤 → ${data.assignee}\n✍️ By: ${data.loggedBy} (${data.loggedByRole})`;
        if(data.photo)await sendTelegramPhoto(cfg.token,cfg.chatId,data.photo,text);
        else await sendTelegram(cfg.token,cfg.chatId,text);
      }
    }catch(e){console.warn("Telegram notification failed:",e);}
  };

  const updateDefect=updated=>{
    setViewing(updated);
    setDefects(prev=>prev.map(d=>d.id===updated.id?updated:d));
  };

  const signOut=()=>{
    DB.auth.signOut();
    local.del(COMPANY_KEY);local.del(PROJECT_KEY);
    local.del(TG_KEY);local.del(GEMINI_KEY);local.del(EMAIL_KEY);local.del(AI_LIMIT_KEY);
    setCompany(null);setMember(null);setAuthUser(null);
    setDefects([]);setProjects([]);setCurrentProject(null);
    setMembers([]);setMemberLoading(false);
  };

  const tgEnabled=!!(local.get(TG_KEY)?.token&&local.get(TG_KEY)?.chatId);
  const aiEnabled=!!local.get(GEMINI_KEY);
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

  const navItems=canLog?NAV:NAV.filter(n=>n.id!=="log");

  return(
    <div style={{maxWidth:430,margin:"0 auto",minHeight:"100vh",background:"#f0ede8",display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{background:"#1a1a1a",padding:"12px 14px 10px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <button onClick={()=>setShowProjects(true)} style={{background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0,flex:1}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:9,fontWeight:700,color:"#ff6b00",letterSpacing:"0.15em"}}>{company.companyName}</div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:15,fontWeight:800,color:"#fff",marginTop:1}}>
            {currentProject?.name||"SELECT PROJECT"} <span style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>▼</span>
          </div>
        </button>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{textAlign:"right",marginRight:2}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:"#fff",lineHeight:1}}>{defects.filter(d=>!["Verified","Closed"].includes(d.status)).length}</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif"}}>ACTIVE</div>
          </div>
          <button onClick={()=>setShowGemini(true)} title="AI Setup" style={{width:32,height:32,borderRadius:8,background:aiEnabled?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${aiEnabled?"rgba(88,86,214,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15}}>🤖</button>
          <button onClick={()=>setShowTg(true)} title="Telegram Setup" style={{width:32,height:32,borderRadius:8,background:tgEnabled?"rgba(0,136,204,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${tgEnabled?"rgba(0,136,204,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21.5 4.5L2.5 11.5L9 13.5L11 20.5L15 15.5L20 18.5L21.5 4.5Z" stroke={tgEnabled?"#0088cc":"rgba(255,255,255,0.4)"} strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </button>
          {isAdmin&&<button onClick={()=>setShowUsers(true)} title="Team Management" style={{width:32,height:32,borderRadius:8,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15}}>👥</button>}
          <button onClick={()=>setShowHelp(true)} title="Help" style={{width:32,height:32,borderRadius:8,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:14,color:"rgba(255,255,255,0.5)"}}>?</button>
          <button onClick={()=>{setShowFeedback(true);setFbSent(false);setFbText("");}} title="Feedback" style={{width:32,height:32,borderRadius:8,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:13}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button onClick={()=>setShowProfile(!showProfile)} style={{width:32,height:32,borderRadius:"50%",background:"#ff6b00",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,color:"#fff",flexShrink:0}}>
            {(member?.name||"?")[0].toUpperCase()}
          </button>
        </div>
      </div>

      {/* Profile dropdown */}
      {showProfile&&(
        <div style={{position:"fixed",inset:0,zIndex:300}} onClick={()=>setShowProfile(false)}>
          <div style={{position:"absolute",top:56,right:8,background:"#1a1a1a",borderRadius:14,padding:16,minWidth:210,animation:"fadeIn 0.15s ease",maxWidth:280}} onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:700,color:"#fff",fontSize:14,marginBottom:2}}>{member?.name}</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:6}}>{member?.email||authUser?.email}</div>
            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:14}}><RoleChip r={member?.role}/><span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>{member?.jobTitle}</span></div>
            <button onClick={()=>{setShowEmail(true);setShowProfile(false);}} style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"none",borderRadius:8,padding:"9px",color:"rgba(255,255,255,0.7)",fontSize:13,cursor:"pointer",marginBottom:6,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600,textAlign:"left"}}>📧 Email Report Settings</button>
            <button onClick={signOut} style={{width:"100%",background:"rgba(255,59,48,0.15)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:8,padding:"9px",color:"#ff6b6b",fontSize:13,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:600}}>Sign Out</button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:72}}>
        {tab==="dashboard"&&<Dashboard defects={defects} onView={setViewing} tgEnabled={tgEnabled} aiEnabled={aiEnabled} syncing={syncing} company={company} currentProject={currentProject} member={member}/>}
        {tab==="log"&&canLog&&<LogDefect member={member} company={company} currentProject={currentProject} members={members} onSave={addDefect}/>}
        {tab==="log"&&!canLog&&<div style={{padding:40,textAlign:"center",color:"rgba(0,0,0,0.4)",fontSize:14}}>Viewer access — defect logging disabled</div>}
        {tab==="defects"&&<DefectsList defects={defects} onView={setViewing}/>}
        {tab==="report"&&<Report defects={defects} onEmailSetup={()=>setShowEmail(true)} currentProject={currentProject} company={company}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#1a1a1a",borderTop:"1px solid rgba(255,255,255,0.06)",display:"flex",padding:"8px 0 12px",zIndex:50}}>
        {navItems.map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"4px 0"}}>
            <div style={{fontSize:n.id==="log"?22:18,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.3)",fontWeight:700,lineHeight:1,fontFamily:n.id==="log"?"'Barlow Condensed',sans-serif":"inherit"}}>{n.icon}</div>
            <div style={{fontSize:9,fontWeight:700,color:tab===n.id?"#ff6b00":"rgba(255,255,255,0.25)",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.08em"}}>{n.label.toUpperCase()}</div>
          </button>
        ))}
      </div>

      {/* Overlays */}
      {viewing&&<DefectDetail defect={viewing} onClose={()=>setViewing(null)} onUpdate={updateDefect} member={member} company={company}/>}
      {showHelp&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.85)",overflowY:"auto"}}>
          <div style={{maxWidth:430,margin:"0 auto",padding:"0 0 40px"}}>
            <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:1}}>
              <button onClick={()=>setShowHelp(false)} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff"}}>HELP</div>
            </div>
            <div style={{padding:"20px 16px"}}>
              {[
                ["Getting Started",[
                  ["What is SiteShrimp?","A mobile-first app for construction site defect tracking. Log defects with photos, voice, and AI — your whole team sees updates instantly."],
                  ["First time?","After signing up and creating your company, set up integrations using the header icons: AI (robot icon), Telegram (paper plane icon). Then invite your team via Team Management (people icon, Admin only)."],
                ]],
                ["Navigation (Bottom Bar)",[
                  ["Dashboard","Overview of all active entries — status counts, severity chart, critical alerts, and recent items."],
                  ["Log (+)","Create a new entry. Select entry type, snap a photo, use AI to auto-fill, or speak into any text field using the mic button."],
                  ["Defects","Browse all entries with filters by status and severity. Tap any entry to view full details, update status, or add comments."],
                  ["Report","Filtered statistics with charts. Export as CSV or send an email report to your team."],
                ]],
                ["Header Icons",[
                  ["Company & Project (top left)","Tap to switch between projects or create new ones."],
                  ["Active count","Shows number of entries not yet Verified or Closed."],
                  ["AI (robot)","Set up your Gemini API key for AI photo analysis. Free at aistudio.google.com."],
                  ["Telegram (plane)","Connect a Telegram bot to get instant notifications when defects are logged or updated."],
                  ["Team (people, Admin only)","Invite members, set roles, manage your team."],
                  ["? (Help)","This guide — how to use the app."],
                  ["Chat (Feedback)","Share suggestions, report bugs, or tell us what you think."],
                  ["Profile (avatar)","View your profile, email report settings, or sign out."],
                ]],
                ["Logging an Entry",[
                  ["1. Entry Type","Select: Defect, Observation, Instruction, or Update."],
                  ["2. Photo","Tap the camera area to snap or upload a photo. Up to 5 photos per entry."],
                  ["3. AI Analysis","If AI is set up, tap 'ANALYZE WITH AI' to auto-fill title, severity, and description from your photo."],
                  ["4. Component & Issue","Tap to select from predefined lists, or tap TYPE to enter a custom value. Use the mic icon to search by voice."],
                  ["5. Location","Select Level, Zone, Room/Area, and Grid Ref. These carry forward in batch mode."],
                  ["6. Voice Input","Tap the mic icon next to any text field to speak instead of type. Works on Title, Description, Grid Ref, Cost fields, and search bars."],
                  ["7. Batch Mode","After submitting, choose 'Log another at same location' to quickly log multiple entries. Location fields stay pre-filled."],
                ]],
                ["Entry Status Flow",[
                  ["Open","New entry, not yet actioned."],
                  ["In Progress","Work has started on this item."],
                  ["Done","Work completed, awaiting verification."],
                  ["Verified","Checked and confirmed by Manager/Admin."],
                  ["Closed","Fully resolved and archived."],
                ]],
                ["Roles & Permissions",[
                  ["Admin","Full access — manage team, delete entries, all features."],
                  ["Manager","Log entries, update status, manage projects, send reports."],
                  ["Inspector","Log entries, add comments, update status on own items."],
                  ["Viewer","Read-only — view entries and reports only."],
                ]],
                ["Tips",[
                  ["Offline","The app shell works offline. You can browse cached data, but need internet to submit new entries."],
                  ["Install as App","Tap the INSTALL button on the login screen, or use your browser's 'Add to Home Screen' option for a native app experience."],
                  ["Multiple Projects","Use the project selector (top left) to switch between projects. Each project has its own set of entries."],
                  ["CSV Export","In the Report tab, use CSV EXPORT to download filtered data for Excel or Google Sheets."],
                ]],
              ].map(([section,items])=>(
                <div key={section} style={{marginBottom:24}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:800,color:"#ff6b00",letterSpacing:"0.08em",marginBottom:10,borderBottom:"1px solid rgba(255,255,255,0.1)",paddingBottom:6}}>{section.toUpperCase()}</div>
                  {items.map(([title,desc])=>(
                    <div key={title} style={{marginBottom:12}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,color:"#fff",marginBottom:2}}>{title}</div>
                      <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.5}}>{desc}</div>
                    </div>
                  ))}
                </div>
              ))}
              {/* Features Checklist */}
              <div style={{marginBottom:24}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:800,color:"#ff6b00",letterSpacing:"0.08em",marginBottom:10,borderBottom:"1px solid rgba(255,255,255,0.1)",paddingBottom:6}}>ALL FEATURES</div>
                {[
                  ["Auth & Onboarding",[["Login / Sign up",true],["Password reset",true],["One-step registration + company setup",true],["Auto-recover session",true],["Install as app",true],["Server URL config",true]]],
                  ["Team",[["Invite members (link + code)",true],["Role-based access control",true],["Edit roles / remove members",true],["Permission matrix display",true]]],
                  ["Projects",[["Create / rename projects",true],["Switch active project",true],["Archive / restore projects",true]]],
                  ["Defect Logging",[["Log with title, severity, location",true],["Multi-level location hierarchy",true],["Snap / upload up to 5 photos",true],["AI photo analysis (Gemini)",true],["Voice-to-text input",true],["Component + issue selector",true],["Assign to team member",true],["Cost & time tracking fields",true],["Batch logging mode",true]]],
                  ["Defect Management",[["Status & severity filters",true],["Full detail view with photos",true],["Update status workflow",true],["Comments (text + voice)",true],["Delete defect (Admin)",true],["Telegram alerts",true]]],
                  ["Dashboard",[["Real-time stats overview",true],["Critical defect alerts",true],["Severity breakdown chart",true],["Recent defects feed",true],["Live sync indicator",true]]],
                  ["Reports",[["Site report with charts",true],["Filter by severity / status / assignee / date",true],["CSV export",true],["Email report (EmailJS)",true]]],
                  ["Settings",[["Telegram bot setup + test",true],["Gemini AI setup + test",true],["Email report config",true],["Daily AI usage limit",true]]],
                  ["Coming Soon",[["Drawings / floor plan pins",false],["Profile editing",false],["Search across defects",false],["Offline submission queue",false],["Push notifications",false]]],
                ].map(([cat,items])=>(
                  <div key={cat} style={{marginBottom:12}}>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.6)",letterSpacing:"0.08em",marginBottom:4}}>{cat.toUpperCase()}</div>
                    {items.map(([feat,done])=>(
                      <div key={feat} style={{display:"flex",gap:8,alignItems:"center",padding:"3px 0",fontSize:12,color:done?"rgba(255,255,255,0.45)":"rgba(255,255,255,0.2)"}}>
                        <span style={{fontSize:10,flexShrink:0,width:14,textAlign:"center"}}>{done?"✓":"○"}</span>
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
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
      {showUsers&&<UserManagement onClose={()=>setShowUsers(false)} company={company} member={member} members={members}/>}
      {showProjects&&<ProjectManagement onClose={()=>setShowProjects(false)} company={company} member={member} projects={projects} currentProject={currentProject} onSelect={p=>{selectProject(p);setShowProjects(false);}}/>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

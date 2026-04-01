// SiteSnag v2 — Multi-tenant Construction Defect Tracker
// Features: Auth, Companies, Projects, Roles, AI, Telegram, Email, PWA
const {useState,useEffect,useRef,useCallback}=React;

// ── Constants ─────────────────────────────────────────────────────
const COMPANY_KEY="sdt-co-v1",TG_KEY="sdt-tg-v2",EMAIL_KEY="sdt-email-v1";
const GEMINI_KEY="sdt-gemini-v1",PROJECT_KEY="sdt-proj-v1";
const USAGE_KEY="sdt-usage-v1";
const FREE_TRIAL_LIMIT=50; // defects per user on shared Firebase
const FREE_TRIAL_USERS=20; // max users per company on shared Firebase
const SEVERITY=["Critical","Major","Minor","Observation"];
const SEV_COLOR={Critical:"#ff3b30",Major:"#ff9500",Minor:"#e6b800",Observation:"#34aadc"};
const SEV_BG={Critical:"rgba(255,59,48,0.12)",Major:"rgba(255,149,0,0.12)",Minor:"rgba(230,184,0,0.12)",Observation:"rgba(52,170,220,0.12)"};
const STATUS=["Open","In Progress","Closed"];
const STATUS_COLOR={Open:"#ff3b30","In Progress":"#ff9500",Closed:"#30d158"};
const ROLES=["Admin","Manager","Inspector","Viewer"];
const ROLE_COLOR={Admin:"#ff3b30",Manager:"#ff9500",Inspector:"#34aadc",Viewer:"#8e8e93"};
const JOB_TITLES=["Site Manager","Project Manager","Engineer","Contractor","QC Inspector","Safety Officer","Supervisor","Architect","Foreman","Other"];

// ── Local Storage ─────────────────────────────────────────────────
const local={
  get:(k)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch{return null;}},
  set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}},
  del:(k)=>{try{localStorage.removeItem(k);}catch{}}
};

// ── Utilities ─────────────────────────────────────────────────────
function compressPhoto(dataUrl,maxPx=400,quality=0.45){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      let w=img.width,h=img.height;
      if(w>maxPx){h=Math.round(h*maxPx/w);w=maxPx;}
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
    d.createdAt?.toDate?d.createdAt.toDate().toLocaleDateString("en-GB"):"",
    `"${(d.description||"").replace(/"/g,'""')}"`,
    `"${(d.comments||[]).map(c=>`${c.by}: ${c.text}`).join(" | ")}"`
  ].join(","));
  const csv=[headers.join(","),...rows].join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download=`SiteSnag_${(projectName||"Export").replace(/\s/g,"_")}_${new Date().toLocaleDateString("en-GB").replace(/\//g,"-")}.csv`;
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
  const closed=defects.filter(d=>d.status==="Closed").length;
  const date=new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
  const defectRows=defects.map(d=>{
    const dt=d.createdAt?.toDate?d.createdAt.toDate().toLocaleDateString("en-GB"):"—";
    const comments=(d.comments||[]).map(c=>`<div style="padding:6px 10px;background:#f5f5f5;border-radius:6px;font-size:12px;margin:4px 0"><b style="color:#ff6b00">${c.by}:</b> ${c.text}</div>`).join("");
    // Photos excluded from email — base64 exceeds EmailJS 50KB free tier limit
    const photo=d.photo?`<div style="font-size:11px;color:#888;font-style:italic;margin-top:6px;padding:6px 8px;background:#f5f5f5;border-radius:6px">📷 Photo available in SiteSnag app</div>`:"";

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
      <div style="color:#ff6b00;font-weight:bold;font-size:10px;letter-spacing:3px">SITESNAG · ${companyName||""}</div>
      <div style="color:#fff;font-size:24px;font-weight:bold;margin-top:4px">${projectName||"SITE"} REPORT</div>
      <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:2px">${date}</div>
    </div>
    <div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px;text-align:center">
      <table style="width:100%"><tr>
        <td><div style="font-size:30px;font-weight:bold">${total}</div><div style="font-size:10px;color:#999">TOTAL</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#ff3b30">${open}</div><div style="font-size:10px;color:#999">OPEN</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#ff9500">${inProg}</div><div style="font-size:10px;color:#999">IN PROGRESS</div></td>
        <td><div style="font-size:30px;font-weight:bold;color:#30d158">${closed}</div><div style="font-size:10px;color:#999">CLOSED</div></td>
      </tr></table>
    </div>
    <div style="background:#fff;padding:18px;border-radius:12px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:2px;margin-bottom:12px">ALL DEFECTS</div>
      ${defectRows||'<div style="color:#999;text-align:center;padding:16px">No defects found.</div>'}
    </div>
    <div style="text-align:center;color:#aaa;font-size:11px;padding:12px">SiteSnag v2 · ${date}</div>
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

function SettingsBack({onClose,title}){
  return(
    <div style={{background:"#1a1a1a",padding:"16px",display:"flex",alignItems:"center",gap:12}}>
      <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#fff"}}>{title}</div>
    </div>
  );
}

// ── Screen: Auth ──────────────────────────────────────────────────
function AuthScreen({onAuth}){
  const[mode,setMode]=useState("login");
  const[email,setEmail]=useState("");const[pw,setPw]=useState("");const[name,setName]=useState("");
  const[err,setErr]=useState("");const[loading,setLoading]=useState(false);
  const inv=new URLSearchParams(window.location.search).get("invite")||"";

  const submit=async()=>{
    if(!email.trim()||!pw.trim()||(mode==="register"&&!name.trim()))return;
    setLoading(true);setErr("");
    try{
      if(mode==="login"){
        const c=await auth.signInWithEmailAndPassword(email.trim(),pw);
        onAuth(c.user,null,inv);
      }else{
        const c=await auth.createUserWithEmailAndPassword(email.trim(),pw);
        await c.user.updateProfile({displayName:name.trim()});
        onAuth(c.user,name.trim(),inv);
      }
    }catch(e){
      const msgs={
        "auth/user-not-found":"No account found — please register.",
        "auth/wrong-password":"Incorrect password.",
        "auth/email-already-in-use":"Email already registered — please login.",
        "auth/weak-password":"Password must be at least 6 characters.",
        "auth/invalid-email":"Please enter a valid email address."
      };
      setErr(msgs[e.code]||e.message);
    }
    setLoading(false);
  };

  const resetPw=async()=>{
    if(!email.trim()){setErr("Enter your email first.");return;}
    try{await auth.sendPasswordResetEmail(email.trim());setErr("✓ Reset email sent. Check your inbox.");}
    catch{setErr("Could not send reset email.");}
  };

  return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:28}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{background:"#ff6b00",width:48,height:6,borderRadius:3,marginBottom:20}}/>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:36,fontWeight:800,color:"#fff",lineHeight:1.1,marginBottom:4}}>SITESNAG</div>
        <div style={{color:"rgba(255,255,255,0.4)",fontSize:13,marginBottom:24}}>Construction Defect Tracker · v2</div>
        {inv&&<div style={{background:"rgba(0,229,100,0.1)",border:"1px solid rgba(0,229,100,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#00e564"}}>✓ Team invite detected — {mode==="register"?"register":"login"} to join your team</div>}
        <div style={{display:"flex",gap:8,marginBottom:20}}>
          {["login","register"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");}} style={{flex:1,background:mode===m?"#ff6b00":"rgba(255,255,255,0.07)",border:"none",borderRadius:10,padding:"11px",color:mode===m?"#fff":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{m==="login"?"LOGIN":"REGISTER"}</button>
          ))}
        </div>
        {mode==="register"&&<div style={{marginBottom:12}}><label style={lbl("#fff")}>FULL NAME</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Your full name" style={darkInp}/></div>}
        <div style={{marginBottom:12}}><label style={lbl("#fff")}>EMAIL</label><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" type="email" style={darkInp}/></div>
        <div style={{marginBottom:16}}><label style={lbl("#fff")}>PASSWORD</label><input value={pw} onChange={e=>setPw(e.target.value)} placeholder={mode==="register"?"Min 6 characters":"Password"} type="password" style={darkInp}/></div>
        {err&&<div style={{background:err.startsWith("✓")?"rgba(0,229,100,0.1)":"rgba(255,59,48,0.12)",border:`1px solid ${err.startsWith("✓")?"rgba(0,229,100,0.3)":"rgba(255,59,48,0.3)"}`,borderRadius:10,padding:"10px 14px",marginBottom:14,color:err.startsWith("✓")?"#00e564":"#ff6b6b",fontSize:13}}>{err}</div>}
        <button onClick={submit} disabled={loading} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10,opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          {loading?<Spin size={16}/>:null}{loading?"PLEASE WAIT...":mode==="login"?"LOGIN →":"CREATE ACCOUNT →"}
        </button>
        {mode==="login"&&<button onClick={resetPw} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:13,cursor:"pointer",padding:"8px"}}>Forgot password?</button>}
      </div>
    </div>
  );
}

// ── Screen: Company Setup ─────────────────────────────────────────
function CompanySetupScreen({user,inviteCode,onDone}){
  const[mode,setMode]=useState(inviteCode?"join":"create");
  const[cName,setCName]=useState("");const[jobTitle,setJobTitle]=useState(JOB_TITLES[0]);
  const[code,setCode]=useState(inviteCode||"");
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");

  const create=async()=>{
    if(!cName.trim())return;
    setLoading(true);setErr("");
    try{
      const ref=db.collection("companies").doc();
      await ref.set({name:cName.trim(),createdAt:firebase.firestore.FieldValue.serverTimestamp(),adminId:user.uid,adminEmail:user.email});
      await ref.collection("members").doc(user.uid).set({name:user.displayName||user.email,email:user.email,role:"Admin",jobTitle,joinedAt:firebase.firestore.FieldValue.serverTimestamp()});
      const pRef=await ref.collection("projects").add({name:"Default Project",createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      const cd={companyId:ref.id,companyName:cName.trim()};
      const proj={id:pRef.id,name:"Default Project"};
      local.set(COMPANY_KEY,cd);local.set(PROJECT_KEY,proj);
      onDone(cd,proj);
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  const join=async()=>{
    if(!code.trim())return;
    setLoading(true);setErr("");
    try{
      const parts=code.trim().split(":");
      if(parts.length!==2)throw new Error("Invalid invite code format — should be companyId:code");
      const[companyId,invCode]=parts;
      const invDoc=await db.collection("companies").doc(companyId).collection("invites").doc(invCode).get();
      if(!invDoc.exists)throw new Error("Invite not found or expired.");
      const invite=invDoc.data();
      if(invite.usedBy)throw new Error("This invite has already been used.");
      if(invite.expiresAt?.toDate&&invite.expiresAt.toDate()<new Date())throw new Error("Invite has expired.");
      // Check member limit on shared Firebase
      if(!isCustomFirebase){
        const memSnap=await db.collection("companies").doc(companyId).collection("members").get();
        if(memSnap.size>=FREE_TRIAL_USERS)throw new Error(`Free trial limited to ${FREE_TRIAL_USERS} members per company. Set up your own Firebase for unlimited users.`);
      }
      await db.collection("companies").doc(companyId).collection("members").doc(user.uid).set({
        name:user.displayName||user.email,email:user.email,
        role:invite.role,jobTitle:invite.jobTitle||JOB_TITLES[0],
        joinedAt:firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection("companies").doc(companyId).collection("invites").doc(invCode).update({usedBy:user.uid,usedAt:firebase.firestore.FieldValue.serverTimestamp()});
      const compDoc=await db.collection("companies").doc(companyId).get();
      const pSnap=await db.collection("companies").doc(companyId).collection("projects").limit(1).get();
      const proj=pSnap.empty?{id:"default",name:"Default"}:{id:pSnap.docs[0].id,...pSnap.docs[0].data()};
      const cd={companyId,companyName:compDoc.data().name};
      local.set(COMPANY_KEY,cd);local.set(PROJECT_KEY,proj);
      onDone(cd,proj);
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",padding:28}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{background:"#ff6b00",width:48,height:6,borderRadius:3,marginBottom:20}}/>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#fff",marginBottom:4}}>SETUP WORKSPACE</div>
        <div style={{color:"rgba(255,255,255,0.4)",fontSize:12,marginBottom:20}}>{user.email}</div>
        <div style={{display:"flex",gap:8,marginBottom:20}}>
          {[["create","Create Company"],["join","Join with Invite"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");}} style={{flex:1,background:mode===m?"#ff6b00":"rgba(255,255,255,0.07)",border:"none",borderRadius:10,padding:"11px",color:mode===m?"#fff":"rgba(255,255,255,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{l.toUpperCase()}</button>
          ))}
        </div>
        {mode==="create"&&<>
          <div style={{marginBottom:12}}><label style={lbl("#fff")}>COMPANY / ORGANISATION NAME</label><input value={cName} onChange={e=>setCName(e.target.value)} placeholder="e.g. ABC Construction Sdn Bhd" style={darkInp}/></div>
          <div style={{marginBottom:20}}><label style={lbl("#fff")}>YOUR JOB TITLE</label><select value={jobTitle} onChange={e=>setJobTitle(e.target.value)} style={{...darkInp,appearance:"none"}}>{JOB_TITLES.map(t=><option key={t} style={{background:"#222"}}>{t}</option>)}</select></div>
          <div style={{background:"rgba(255,107,0,0.1)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"rgba(255,255,255,0.6)"}}>You will be the <b style={{color:"#ff6b00"}}>Admin</b>. Invite your team after setup.</div>
          <button onClick={create} disabled={loading||!cName.trim()} style={{width:"100%",background:cName.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {loading?<Spin size={16}/>:null}{loading?"CREATING...":"CREATE COMPANY →"}
          </button>
        </>}
        {mode==="join"&&<>
          <div style={{marginBottom:20}}><label style={lbl("#fff")}>INVITE CODE</label><input value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste your invite code here" style={darkInp}/><div style={{color:"rgba(255,255,255,0.3)",fontSize:11,marginTop:6}}>Your admin will share this invite link/code with you</div></div>
          <button onClick={join} disabled={loading||!code.trim()} style={{width:"100%",background:code.trim()?"#ff6b00":"rgba(255,255,255,0.1)",border:"none",borderRadius:10,padding:"15px",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",opacity:loading?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {loading?<Spin size={16}/>:null}{loading?"JOINING...":"JOIN COMPANY →"}
          </button>
        </>}
        {err&&<div style={{background:"rgba(255,59,48,0.12)",border:"1px solid rgba(255,59,48,0.3)",borderRadius:10,padding:"10px 14px",marginTop:14,color:"#ff6b6b",fontSize:13}}>{err}</div>}
        <button onClick={()=>auth.signOut()} style={{width:"100%",background:"none",border:"none",color:"rgba(255,255,255,0.2)",fontSize:13,cursor:"pointer",padding:"16px 8px",marginTop:8}}>← Sign out</button>
      </div>
    </div>
  );
}

// ── User Management (Admin only) ──────────────────────────────────
function UserManagement({onClose,company,member,members}){
  const[invRole,setInvRole]=useState("Inspector");
  const[invJob,setInvJob]=useState(JOB_TITLES[0]);
  const[link,setLink]=useState("");
  const[gen,setGen]=useState(false);
  const[copied,setCopied]=useState(false);
  const[editing,setEditing]=useState(null);

  const genInvite=async()=>{
    setGen(true);setLink("");
    try{
      const code=Math.random().toString(36).substring(2,10).toUpperCase();
      await db.collection("companies").doc(company.companyId).collection("invites").doc(code).set({
        role:invRole,jobTitle:invJob,
        createdAt:firebase.firestore.FieldValue.serverTimestamp(),
        createdBy:auth.currentUser.uid,
        expiresAt:new Date(Date.now()+7*24*60*60*1000)
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
    await db.collection("companies").doc(company.companyId).collection("members").doc(uid).update({role});
    setEditing(null);
  };

  const removeMember=async uid=>{
    if(!confirm("Remove this member from the company?"))return;
    await db.collection("companies").doc(company.companyId).collection("members").doc(uid).delete();
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
                <div style={{fontWeight:600,fontSize:14,color:"#1a1a1a"}}>{m.name}{m.uid===auth.currentUser?.uid?" (you)":""}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginTop:2}}>{m.email} · {m.jobTitle||"—"}</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <RoleChip r={m.role}/>
                {member.role==="Admin"&&m.uid!==auth.currentUser?.uid&&(
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
          <div style={{marginBottom:14}}>
            <div style={lbl()}>JOB TITLE</div>
            <select value={invJob} onChange={e=>setInvJob(e.target.value)} style={{...inp,width:"100%",flex:"unset",appearance:"none"}}>
              {JOB_TITLES.map(t=><option key={t}>{t}</option>)}
            </select>
          </div>
          <button onClick={genInvite} disabled={gen} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {gen?<Spin size={14}/>:null}{gen?"GENERATING...":"GENERATE INVITE LINK"}
          </button>
          {link&&(
            <div style={{marginTop:12}}>
              <div style={{background:"rgba(48,209,88,0.08)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:10,padding:"10px 12px",fontSize:11,color:"#1a7a35",wordBreak:"break-all",marginBottom:8}}>{link}</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={copyLink} style={{flex:1,background:copied?"rgba(48,209,88,0.1)":"rgba(0,0,0,0.06)",border:`1px solid ${copied?"rgba(48,209,88,0.3)":"rgba(0,0,0,0.1)"}`,borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",color:copied?"#1a7a35":"#1a1a1a",fontFamily:"'Barlow Condensed',sans-serif"}}>{copied?"✓ COPIED!":"COPY LINK"}</button>
                <button onClick={()=>{if(navigator.share)navigator.share({title:"SiteSnag Team Invite",url:link});else copyLink();}} style={{flex:1,background:"#ff6b00",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif"}}>SHARE</button>
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
  const canManage=["Admin","Manager"].includes(member?.role);

  const addProject=async()=>{
    if(!newName.trim())return;setAdding(true);
    try{
      const ref=await db.collection("companies").doc(company.companyId).collection("projects").add({name:newName.trim(),createdAt:firebase.firestore.FieldValue.serverTimestamp(),createdBy:auth.currentUser?.uid});
      onSelect({id:ref.id,name:newName.trim()});
      setNewName("");
    }catch(e){alert(e.message);}
    setAdding(false);
  };

  const renameProject=async(id)=>{
    if(!editName.trim())return;
    await db.collection("companies").doc(company.companyId).collection("projects").doc(id).update({name:editName.trim()});
    if(currentProject?.id===id)onSelect({id,name:editName.trim()});
    setEditingId(null);setEditName("");
  };

  const archiveProject=async id=>{
    if(projects.length<=1){alert("Cannot archive the only project.");return;}
    if(!confirm("Archive this project? Defects will be preserved."))return;
    await db.collection("companies").doc(company.companyId).collection("projects").doc(id).update({archived:true});
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
      </div>
    </div>
  );
}

// ── Settings Sync (save to Firestore + localStorage) ─────────────
function saveSettingToFirestore(companyId,key,value){
  if(!companyId)return;
  try{db.collection("companies").doc(companyId).collection("settings").doc(key).set({value,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});}catch(e){console.warn("Settings save failed:",e);}
}
async function loadSettingsFromFirestore(companyId){
  if(!companyId)return;
  try{
    const snap=await db.collection("companies").doc(companyId).collection("settings").get();
    snap.docs.forEach(doc=>{
      const key=doc.id;const val=doc.data().value;
      if(key==="telegram")local.set(TG_KEY,val);
      if(key==="gemini")local.set(GEMINI_KEY,val);
      if(key==="email")local.set(EMAIL_KEY,val);
    });
  }catch(e){console.warn("Settings load failed:",e);}
}

// ── Telegram Settings ─────────────────────────────────────────────
function TelegramSettings({onClose,companyId}){
  const[token,setToken]=useState(()=>local.get(TG_KEY)?.token||"");
  const[chatId,setChatId]=useState(()=>local.get(TG_KEY)?.chatId||"");
  const[saved,setSaved]=useState(false);const[testRes,setTestRes]=useState(null);const[testing,setTesting]=useState(false);
  const save=()=>{const cfg={token:token.trim(),chatId:chatId.trim()};local.set(TG_KEY,cfg);saveSettingToFirestore(companyId,"telegram",cfg);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const test=async()=>{setTesting(true);setTestRes(null);const ok=await sendTelegram(token.trim(),chatId.trim(),"✅ <b>SiteSnag</b>\nTelegram connected successfully!");setTestRes(ok?"success":"fail");setTesting(false);};
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
  const closed=defects.filter(d=>d.status==="Closed").length;
  const critical=defects.filter(d=>d.severity==="Critical"&&d.status!=="Closed").length;
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

      <div style={{display:"flex",gap:10,marginBottom:10}}>
        <Card label="OPEN" value={open} color="#ff3b30"/>
        <Card label="IN PROG" value={inprog} color="#ff9500"/>
        <Card label="CLOSED" value={closed} color="#30d158"/>
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

// ── Log Defect (with AI + Batch) ──────────────────────────────────
function LogDefect({member,company,currentProject,members,onSave}){
  const blank={title:"",location:"",severity:"Major",description:"",assignee:member?.name||"",photo:null};
  const[form,setForm]=useState(blank);
  const[saving,setSaving]=useState(false);const[analyzing,setAnalyzing]=useState(false);const[aiResult,setAiResult]=useState(null);
  const[count,setCount]=useState(0);const[last,setLast]=useState(null);const[showBatch,setShowBatch]=useState(false);
  const fileRef=useRef();
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const geminiKey=local.get(GEMINI_KEY);
  const assignees=members.length>0?members.map(m=>m.name):["Site Manager","Engineer","Contractor","QC Inspector","Safety Officer"];

  const handlePhoto=e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();r.onload=()=>set("photo",r.result);r.readAsDataURL(f);
    setAiResult(null);
  };

  const AI_LIMIT_KEY="sdt-ai-usage";
  const AI_DAILY_LIMIT=10;

  const analyze=async()=>{
    if(!form.photo||!geminiKey)return;
    // Check daily AI limit
    const today=new Date().toISOString().slice(0,10);
    const aiUsage=local.get(AI_LIMIT_KEY)||{date:"",count:0};
    const todayCount=aiUsage.date===today?aiUsage.count:0;
    if(todayCount>=AI_DAILY_LIMIT){
      alert(`AI analysis limit reached (${AI_DAILY_LIMIT}/day).\n\nYou can still log defects manually.`);
      return;
    }
    setAnalyzing(true);
    const compressed=await compressPhoto(form.photo,600,0.7);
    const result=await analyzeWithGemini(geminiKey,compressed||form.photo);
    // Increment AI usage
    local.set(AI_LIMIT_KEY,{date:today,count:todayCount+1});
    if(result){
      setAiResult(result);
      if(result.title)set("title",result.title);
      if(result.severity&&SEVERITY.includes(result.severity))set("severity",result.severity);
      if(result.description)set("description",result.description);
    }
    setAnalyzing(false);
  };

  const submit=async()=>{
    if(!form.title.trim()||!form.location.trim())return;
    setSaving(true);
    try{
      let photo=form.photo;
      if(photo)photo=await compressPhoto(photo);
      await onSave({
        ...form,photo,
        projectId:currentProject?.id||"default",
        projectName:currentProject?.name||"",
        status:"Open",loggedBy:member?.name||"",
        loggedByRole:member?.role||"",
        createdAt:firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
        comments:[]
      });
      setLast({location:form.location,assignee:form.assignee,severity:form.severity});
      setCount(c=>c+1);setShowBatch(true);setForm(blank);setAiResult(null);
    }catch(e){alert("Error saving: "+e.message);}
    setSaving(false);
  };

  if(showBatch)return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.3)",borderRadius:14,padding:24,textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:8}}>✓</div>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"#1a7a35",marginBottom:4}}>DEFECT LOGGED</div>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)"}}>{count} logged this session · Team notified</div>
      </div>
      <div style={{background:"#fff",borderRadius:14,padding:14,marginBottom:12}}>
        <div style={{fontSize:13,color:"rgba(0,0,0,0.5)",marginBottom:6}}>Log another at the same location?</div>
        <div style={{fontSize:12,color:"rgba(0,0,0,0.4)"}}>📍 {last?.location} · → {last?.assignee}</div>
      </div>
      <button onClick={()=>{setForm({...blank,location:last?.location||"",assignee:last?.assignee||member?.name||"",severity:last?.severity||"Major"});setShowBatch(false);}} style={{width:"100%",background:"#ff6b00",border:"none",borderRadius:12,padding:16,color:"#fff",fontSize:15,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10}}>➕ LOG ANOTHER HERE</button>
      <button onClick={()=>setShowBatch(false)} style={{width:"100%",background:"rgba(0,0,0,0.06)",border:"none",borderRadius:12,padding:14,fontSize:14,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer"}}>✓ DONE — VIEW ALL</button>
    </div>
  );

  return(
    <div style={{padding:"20px 16px",animation:"fadeIn 0.25s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:"#1a1a1a"}}>LOG DEFECT</div>
        {count>0&&<div style={{fontSize:10,fontWeight:700,color:"#30d158",background:"rgba(48,209,88,0.1)",border:"1px solid rgba(48,209,88,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>{count} LOGGED</div>}
        <div style={{fontSize:10,fontWeight:700,color:"#ff6b00",background:"rgba(255,107,0,0.1)",border:"1px solid rgba(255,107,0,0.2)",borderRadius:20,padding:"3px 8px",fontFamily:"'Barlow Condensed',sans-serif"}}>🎙 VOICE</div>
      </div>
      <div style={{fontSize:11,color:"rgba(0,0,0,0.4)",marginBottom:20}}>📁 {currentProject?.name||"—"} · Tap 🎙 to dictate</div>

      <VoiceField label="DEFECT TITLE *" value={form.title} onChange={v=>set("title",v)} placeholder="e.g. Crack in column C4"/>
      <VoiceField label="LOCATION *" value={form.location} onChange={v=>set("location",v)} placeholder="e.g. Level 3, Grid C4"/>

      <div style={{marginBottom:16}}>
        <label style={lbl()}>SEVERITY</label>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {SEVERITY.map(s=>(
            <button key={s} onClick={()=>set("severity",s)} style={{padding:"8px 14px",borderRadius:20,border:`2px solid ${form.severity===s?SEV_COLOR[s]:"rgba(0,0,0,0.12)"}`,background:form.severity===s?SEV_BG[s]:"#fff",color:form.severity===s?SEV_COLOR[s]:"rgba(0,0,0,0.5)",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>{s.toUpperCase()}</button>
          ))}
        </div>
      </div>

      <div style={{marginBottom:16}}>
        <label style={lbl()}>ASSIGN TO</label>
        <select value={form.assignee} onChange={e=>set("assignee",e.target.value)} style={{...inp,width:"100%",flex:"unset",appearance:"none"}}>
          {assignees.map(t=><option key={t}>{t}</option>)}
        </select>
      </div>

      <VoiceField label="DESCRIPTION" value={form.description} onChange={v=>set("description",v)} placeholder="Describe the defect..." multiline/>

      <div style={{marginBottom:20}}>
        <label style={lbl()}>PHOTO</label>
        <input type="file" accept="image/*" capture="environment" ref={fileRef} onChange={handlePhoto} style={{display:"none"}}/>
        {form.photo?(
          <div>
            <div style={{position:"relative",marginBottom:8}}>
              <img src={form.photo} alt="" style={{width:"100%",borderRadius:10,maxHeight:200,objectFit:"cover"}}/>
              <button onClick={()=>{set("photo",null);setAiResult(null);}} style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",border:"none",borderRadius:20,color:"#fff",padding:"4px 10px",fontSize:12,cursor:"pointer"}}>Remove</button>
            </div>
            {geminiKey&&(
              <button onClick={analyze} disabled={analyzing} style={{width:"100%",background:"rgba(88,86,214,0.08)",border:"1.5px solid rgba(88,86,214,0.3)",borderRadius:10,padding:"11px",color:"#5856d6",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {analyzing?<><Spin size={14}/><span>ANALYZING...</span></>:<><span>🤖</span><span>ANALYZE WITH AI</span></>}
              </button>
            )}
            {!geminiKey&&<div style={{fontSize:11,color:"rgba(0,0,0,0.35)",textAlign:"center",padding:"6px 0"}}>Setup AI (🤖 in header) to auto-fill from photo</div>}
            {aiResult&&(
              <div style={{background:"rgba(88,86,214,0.06)",border:"1px solid rgba(88,86,214,0.2)",borderRadius:10,padding:"10px 12px",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#5856d6",marginBottom:4,fontFamily:"'Barlow Condensed',sans-serif"}}>✓ AI FILLED — REVIEW & EDIT ABOVE</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,0.5)"}}>{aiResult.description}</div>
              </div>
            )}
          </div>
        ):(
          <button onClick={()=>fileRef.current.click()} style={{width:"100%",background:"#fff",border:"2px dashed rgba(0,0,0,0.15)",borderRadius:10,padding:20,color:"rgba(0,0,0,0.4)",fontSize:14,cursor:"pointer"}}>📷 Add photo{geminiKey?" · AI will auto-analyze":""}</button>
        )}
      </div>

      <button onClick={submit} disabled={saving||!form.title.trim()||!form.location.trim()} style={{width:"100%",background:form.title.trim()&&form.location.trim()&&!saving?"#ff6b00":"rgba(0,0,0,0.1)",border:"none",borderRadius:12,padding:16,color:form.title.trim()&&form.location.trim()?"#fff":"rgba(0,0,0,0.3)",fontSize:16,fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.06em",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {saving?<><Spin size={16}/><span>SAVING...</span></>:"SUBMIT DEFECT"}
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
            <span>{d.createdAt?.toDate?d.createdAt.toDate().toLocaleDateString():"Just now"}</span>
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
  const tgCfg=local.get(TG_KEY);
  const canUpdate=["Admin","Manager","Inspector"].includes(member?.role);
  const canDelete=member?.role==="Admin";

  const updateStatus=async s=>{
    if(!canUpdate)return;
    setStatus(s);
    await db.collection("companies").doc(company.companyId).collection("defects").doc(defect.id).update({status:s,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    onUpdate({...defect,status:s});
    if(tgCfg?.token&&tgCfg?.chatId){
      const e={Open:"🔴","In Progress":"🟡",Closed:"🟢"}[s]||"⚪";
      await sendTelegram(tgCfg.token,tgCfg.chatId,`${e} <b>Status Updated</b>\n<b>${defect.title}</b>\nStatus: <b>${s}</b>\nBy: ${member?.name}`);
    }
  };

  const addComment=async()=>{
    if(!comment.trim()||saving||!canUpdate)return;
    setSaving(true);
    const newComment={text:comment,by:member?.name||"",role:member?.role||"",at:Date.now()};
    const newComments=[...(defect.comments||[]),newComment];
    await db.collection("companies").doc(company.companyId).collection("defects").doc(defect.id).update({comments:newComments,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    onUpdate({...defect,comments:newComments});
    if(tgCfg?.token&&tgCfg?.chatId)await sendTelegram(tgCfg.token,tgCfg.chatId,`💬 <b>Comment — ${defect.title}</b>\n${member?.name}: ${comment}`);
    setComment("");setSaving(false);
  };

  const deleteDefect=async()=>{
    if(!canDelete||!confirm("Delete this defect permanently? This cannot be undone."))return;
    setDeleting(true);
    await db.collection("companies").doc(company.companyId).collection("defects").doc(defect.id).delete();
    onClose();
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#f0ede8",zIndex:100,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <div style={{position:"sticky",top:0,background:"rgba(240,237,232,0.95)",backdropFilter:"blur(8px)",padding:"16px 16px 12px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid rgba(0,0,0,0.08)",zIndex:10}}>
        <button onClick={onClose} style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:20,padding:"7px 14px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>← BACK</button>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,color:"#1a1a1a",flex:1}}>DEFECT DETAIL</div>
        {canDelete&&<button onClick={deleteDefect} disabled={deleting} style={{background:"rgba(255,59,48,0.1)",border:"none",borderRadius:20,padding:"7px 14px",color:"#ff3b30",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>{deleting?"...":"DELETE"}</button>}
      </div>
      <div style={{padding:16}}>
        <div style={{background:"#fff",borderRadius:14,padding:16,marginBottom:14,borderLeft:`5px solid ${SEV_COLOR[defect.severity]}`}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:20,color:"#1a1a1a",marginBottom:10}}>{defect.title}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}><SevChip s={defect.severity}/><StatusChip s={status}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["📍 Location",defect.location],["👤 Assigned",defect.assignee],["📁 Project",defect.projectName||"—"],["🗓 Date",defect.createdAt?.toDate?defect.createdAt.toDate().toLocaleDateString():"—"],["✍️ Logged by",defect.loggedBy],["🔑 Role",defect.loggedByRole||"—"]].map(([l,v])=>(
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

        {defect.photo&&<img src={defect.photo} alt="" style={{width:"100%",borderRadius:12,maxHeight:250,objectFit:"cover",marginBottom:14}}/>}

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
      const dt=d.createdAt?.toDate?d.createdAt.toDate():null;
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
        await emailjs.send(emailCfg.serviceId,emailCfg.templateId,{to_email:email,subject:`SiteSnag Report – ${currentProject?.name||""} – ${date}`,html_content:html});
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

// ── Firebase Config Setup (Bring Your Own Firebase) ──────────────
function FirebaseSetupScreen({onDone}){
  const[mode,setMode]=useState("choose");
  const[config,setConfig]=useState("");
  const[err,setErr]=useState("");
  const[loading,setLoading]=useState(false);

  const useDefault=()=>{
    localStorage.removeItem(FIREBASE_CFG_KEY);
    onDone();
  };

  const useCustom=()=>{
    setErr("");
    setLoading(true);
    try{
      // Try parsing JSON directly or extract from code snippet
      let parsed;
      const jsonMatch=config.match(/\{[\s\S]*apiKey[\s\S]*\}/);
      if(jsonMatch){
        // Replace single quotes with double quotes, handle unquoted keys
        let clean=jsonMatch[0].replace(/'/g,'"').replace(/(\w+)\s*:/g,'"$1":').replace(/,\s*}/g,'}');
        parsed=JSON.parse(clean);
      }else{
        parsed=JSON.parse(config);
      }
      if(!parsed.apiKey||!parsed.projectId||!parsed.authDomain){
        setErr("Missing required fields: apiKey, projectId, authDomain");
        setLoading(false);
        return;
      }
      localStorage.setItem(FIREBASE_CFG_KEY,JSON.stringify(parsed));
      // Reload to reinitialize Firebase with new config
      window.location.reload();
    }catch(e){
      setErr("Invalid config. Paste the firebaseConfig object from Firebase Console.");
      setLoading(false);
    }
  };

  const S={
    wrap:{minHeight:"100vh",background:"linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20},
    card:{background:"#fff",borderRadius:20,padding:"32px 24px",width:"100%",maxWidth:420},
    title:{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:24,color:"#1a1a1a",marginBottom:4},
    sub:{fontSize:13,color:"rgba(0,0,0,0.5)",marginBottom:24},
    btn:{width:"100%",padding:16,border:"none",borderRadius:12,fontSize:15,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",cursor:"pointer",marginBottom:10},
    textarea:{width:"100%",minHeight:120,padding:12,border:"1.5px solid #ddd",borderRadius:10,fontSize:12,fontFamily:"monospace",marginBottom:12,resize:"vertical"},
    err:{color:"#ff3b30",fontSize:12,marginBottom:10},
    info:{fontSize:12,color:"rgba(0,0,0,0.4)",lineHeight:1.6,marginBottom:16},
  };

  if(mode==="choose")return(
    <div style={S.wrap}><div style={S.card}>
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:8}}>🔥</div>
        <div style={S.title}>DATA PRIVACY SETUP</div>
        <div style={S.sub}>Where should your defect data be stored?</div>
      </div>
      <button onClick={useDefault} style={{...S.btn,background:"#ff6b00",color:"#fff"}}>
        FREE TRIAL — START NOW
      </button>
      <div style={{textAlign:"center",fontSize:11,color:"rgba(0,0,0,0.35)",marginBottom:8}}>{FREE_TRIAL_LIMIT} defects · {FREE_TRIAL_USERS} team members · No setup needed.</div>
      <button onClick={()=>setMode("custom")} style={{...S.btn,background:"rgba(0,0,0,0.06)",color:"#1a1a1a"}}>
        OWN FIREBASE (unlimited + private)
      </button>
      <div style={{textAlign:"center",fontSize:11,color:"rgba(0,0,0,0.35)"}}>Your data stays in YOUR Firebase project. Free forever.</div>
    </div></div>
  );

  return(
    <div style={S.wrap}><div style={S.card}>
      <div style={S.title}>YOUR FIREBASE CONFIG</div>
      <div style={S.info}>
        1. Go to <b>console.firebase.google.com</b><br/>
        2. Create a project (free)<br/>
        3. Enable <b>Authentication</b> → Email/Password<br/>
        4. Create <b>Firestore Database</b> (production mode)<br/>
        5. Go to Project Settings → General → scroll to "Your apps" → Web app<br/>
        6. Copy the <b>firebaseConfig</b> object and paste below:
      </div>
      <textarea style={S.textarea} placeholder={'{\n  apiKey: "AIza...",\n  authDomain: "your-project.firebaseapp.com",\n  projectId: "your-project-id",\n  storageBucket: "...",\n  messagingSenderId: "...",\n  appId: "..."\n}'} value={config} onChange={e=>setConfig(e.target.value)}/>
      {err&&<div style={S.err}>{err}</div>}
      <button onClick={useCustom} disabled={loading||!config.trim()} style={{...S.btn,background:config.trim()?"#ff6b00":"#ccc",color:"#fff"}}>{loading?"CONNECTING...":"CONNECT MY FIREBASE"}</button>
      <button onClick={()=>setMode("choose")} style={{...S.btn,background:"none",color:"rgba(0,0,0,0.4)",fontSize:13}}>← Back</button>
    </div></div>
  );
}

function App(){
  const[firebaseReady,setFirebaseReady]=useState(()=>{
    // Skip setup screen if user already has a saved config, used the app before, or is logged in
    return !!localStorage.getItem(FIREBASE_CFG_KEY)||!!localStorage.getItem(COMPANY_KEY)||!!auth.currentUser;
  });
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

  // Auth listener — also auto-recover company if localStorage was cleared
  useEffect(()=>{
    const inv=new URLSearchParams(window.location.search).get("invite")||"";
    setInviteCode(inv);
    return auth.onAuthStateChanged(async u=>{
      setAuthUser(u);
      setFirebaseReady(true); // skip setup screen if user is logged in
      // Auto-recover company if user is logged in but company is missing from localStorage
      if(u&&!local.get(COMPANY_KEY)){
        try{
          const companiesSnap=await db.collection("companies").get();
          for(const compDoc of companiesSnap.docs){
            const memDoc=await compDoc.ref.collection("members").doc(u.uid).get();
            if(memDoc.exists){
              const cd={companyId:compDoc.id,companyName:compDoc.data().name};
              local.set(COMPANY_KEY,cd);
              setCompany(cd);
              // Also recover project
              const projSnap=await compDoc.ref.collection("projects").limit(1).get();
              if(!projSnap.empty){
                const proj={id:projSnap.docs[0].id,...projSnap.docs[0].data()};
                local.set(PROJECT_KEY,proj);
                setCurrentProject(proj);
              }
              // Recover settings (Telegram, Gemini, Email)
              await loadSettingsFromFirestore(compDoc.id);
              break;
            }
          }
        }catch(e){console.warn("Auto-recover failed:",e);}
      }
      setAuthLoading(false);
    });
  },[]);

  // Member + all members listener
  useEffect(()=>{
    if(!authUser||!company?.companyId)return;
    setMemberLoading(true);
    const u1=db.collection("companies").doc(company.companyId).collection("members").doc(authUser.uid).onSnapshot(doc=>{
      if(doc.exists)setMember({uid:authUser.uid,...doc.data()});
      else setMember(null);
      setMemberLoading(false);
    });
    const u2=db.collection("companies").doc(company.companyId).collection("members").onSnapshot(snap=>{
      setMembers(snap.docs.map(d=>({uid:d.id,...d.data()})));
    });
    return()=>{u1();u2();};
  },[authUser?.uid,company?.companyId]);

  // Projects listener
  useEffect(()=>{
    if(!company?.companyId)return;
    return db.collection("companies").doc(company.companyId).collection("projects").onSnapshot(snap=>{
      const projs=snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>!p.archived);
      setProjects(projs);
      if(!currentProject&&projs.length>0){setCurrentProject(projs[0]);local.set(PROJECT_KEY,projs[0]);}
    },err=>console.error("Projects:",err));
  },[company?.companyId]);

  // Defects listener
  useEffect(()=>{
    if(!company?.companyId||!currentProject?.id)return;
    setSyncing(true);
    return db.collection("companies").doc(company.companyId).collection("defects")
      .where("projectId","==",currentProject.id).orderBy("createdAt","desc")
      .onSnapshot(snap=>{
        setDefects(snap.docs.map(d=>({id:d.id,...d.data()})));
        setSyncing(false);
      },err=>{
        console.error("Defects query error:",err.message);
        if(err.message&&err.message.includes("index")){
          console.warn("⚠️ Missing Firestore index. Create at: Firebase Console → Firestore → Indexes → Add: companies/{id}/defects, fields: projectId ASC + createdAt DESC");
        }
        setSyncing(false);
      });
  },[company?.companyId,currentProject?.id]);

  const handleAuth=(user,name,inv)=>{setAuthUser(user);if(inv)setInviteCode(inv);};

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

    // Check usage limit on shared Firebase
    if(!isCustomFirebase){
      const usage=local.get(USAGE_KEY)||0;
      if(usage>=FREE_TRIAL_LIMIT){
        const msg=`You've reached ${FREE_TRIAL_LIMIT} free defects on the shared server.\n\nTo continue, set up your own Firebase (free, 5 minutes).\n\nGo to Settings → Sign Out, then choose "Own Firebase" on restart.`;
        alert(msg);
        return;
      }
    }

    await db.collection("companies").doc(company.companyId).collection("defects").add(data);

    // Increment usage counter on shared Firebase
    if(!isCustomFirebase){
      const usage=local.get(USAGE_KEY)||0;
      local.set(USAGE_KEY,usage+1);
      const remaining=FREE_TRIAL_LIMIT-(usage+1);
      if(remaining===5||remaining===2){
        setTimeout(()=>alert(`${remaining} free defects remaining on shared server.\n\nSet up your own Firebase for unlimited use (free).`),1000);
      }
    }

    const cfg=local.get(TG_KEY);
    if(cfg?.token&&cfg?.chatId){
      const e={Critical:"🔴",Major:"🟠",Minor:"🟡",Observation:"🔵"}[data.severity]||"⚪";
      const text=`${e} <b>NEW DEFECT — ${company.companyName}</b>\n\n📁 ${currentProject.name}\n📋 <b>${data.title}</b>\n📍 ${data.location}\n⚠️ ${data.severity}\n👤 → ${data.assignee}\n✍️ By: ${data.loggedBy} (${data.loggedByRole})`;
      if(data.photo)await sendTelegramPhoto(cfg.token,cfg.chatId,data.photo,text);
      else await sendTelegram(cfg.token,cfg.chatId,text);
    }
  };

  const updateDefect=updated=>{
    setViewing(updated);
    setDefects(prev=>prev.map(d=>d.id===updated.id?updated:d));
  };

  const signOut=()=>{
    auth.signOut();
    local.del(COMPANY_KEY);local.del(PROJECT_KEY);
    setCompany(null);setMember(null);setAuthUser(null);
    setDefects([]);setProjects([]);setCurrentProject(null);
    setMembers([]);setMemberLoading(false);
  };

  const tgEnabled=!!(local.get(TG_KEY)?.token&&local.get(TG_KEY)?.chatId);
  const aiEnabled=!!local.get(GEMINI_KEY);
  const canLog=["Admin","Manager","Inspector"].includes(member?.role);
  const isAdmin=member?.role==="Admin";

  if(authLoading||memberLoading)return(
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:"#ff6b00",marginBottom:16}}>SITESNAG</div>
        <Spin size={24}/>
      </div>
    </div>
  );

  if(!firebaseReady)return <FirebaseSetupScreen onDone={()=>setFirebaseReady(true)}/>;
  if(!authUser)return <AuthScreen onAuth={handleAuth}/>;
  if(!company||!member)return <CompanySetupScreen user={authUser} inviteCode={inviteCode} onDone={handleCompanyDone}/>;

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
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:"#fff",lineHeight:1}}>{defects.filter(d=>d.status==="Open").length}</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",fontFamily:"'Barlow Condensed',sans-serif"}}>OPEN</div>
          </div>
          <button onClick={()=>setShowGemini(true)} title="AI Setup" style={{width:32,height:32,borderRadius:8,background:aiEnabled?"rgba(88,86,214,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${aiEnabled?"rgba(88,86,214,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15}}>🤖</button>
          <button onClick={()=>setShowTg(true)} title="Telegram Setup" style={{width:32,height:32,borderRadius:8,background:tgEnabled?"rgba(0,136,204,0.2)":"rgba(255,255,255,0.07)",border:`1px solid ${tgEnabled?"rgba(0,136,204,0.4)":"rgba(255,255,255,0.1)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21.5 4.5L2.5 11.5L9 13.5L11 20.5L15 15.5L20 18.5L21.5 4.5Z" stroke={tgEnabled?"#0088cc":"rgba(255,255,255,0.4)"} strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </button>
          {isAdmin&&<button onClick={()=>setShowUsers(true)} title="Team Management" style={{width:32,height:32,borderRadius:8,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15}}>👥</button>}
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
      {showTg&&<TelegramSettings onClose={()=>setShowTg(false)} companyId={company?.companyId}/>}
      {showEmail&&<EmailSettings onClose={()=>setShowEmail(false)} companyId={company?.companyId}/>}
      {showGemini&&<GeminiSettings onClose={()=>setShowGemini(false)} companyId={company?.companyId}/>}
      {showUsers&&<UserManagement onClose={()=>setShowUsers(false)} company={company} member={member} members={members}/>}
      {showProjects&&<ProjectManagement onClose={()=>setShowProjects(false)} company={company} member={member} projects={projects} currentProject={currentProject} onSelect={p=>{selectProject(p);setShowProjects(false);}}/>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

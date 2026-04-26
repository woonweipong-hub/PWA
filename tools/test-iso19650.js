#!/usr/bin/env node
/**
 * Step-1 unit harness for the ISO 19650-aligned filename builder + parser.
 *
 * Extracts the marked block from js/app.js and evaluates it in an isolated
 * Function() scope so we can test without React/DOM. Exits 0 on success,
 * 1 on first failure. Run with: node tools/test-iso19650.js
 *
 * Covers the four cases agreed in step 1:
 *   1. Generic defect photo (no element/checkpoint)
 *   2. CONQUAS checkpoint photo (with element + hyphenated checkpoint id)
 *   3. Whole-project (ZZ-ZZ) — no specific volume/level
 *   4. Hash-mismatch detection (parser returns hash; caller compares)
 *
 * Plus round-trip and revision-bump checks because they're cheap.
 */
const fs=require("fs");
const path=require("path");

const APP=fs.readFileSync(path.join(__dirname,"..","js","app.js"),"utf8");
// Capture only what's BETWEEN the marker lines (markers themselves are inside
// // comments in app.js — including them in extracted source would break JS
// because the comment prefix isn't preserved by the regex).
const m=APP.match(/ISO19650-EXPORT-START[^\n]*\n([\s\S]*?)\n[^\n]*ISO19650-EXPORT-END/);
if(!m){
  console.error("FAIL: ISO19650-EXPORT-START/END markers not found in js/app.js");
  process.exit(1);
}
// Eval the extracted block, exposing the symbols we want to test.
const exported={};
new Function("__out",
  m[1]+"\n"+
  "Object.assign(__out,{"+
  "captureTimezone,mediaHash,slugCode,roleFromTrade,suitabilityFromStatus,"+
  "buildIso19650Filename,isoNameForDefect,parseIso19650Filename,"+
  "ISO_ROLE_BY_TRADE,ISO_SUITABILITY_BY_STATUS,ISO_STAGE_SHORT"+
  "});"
)(exported);

const{buildIso19650Filename,isoNameForDefect,parseIso19650Filename}=exported;

let pass=0,fail=0;
function eq(label,actual,expected){
  const ok=actual===expected;
  if(ok){pass++;console.log("  PASS  "+label);}
  else{fail++;console.log("  FAIL  "+label+"\n        expected: "+JSON.stringify(expected)+"\n        actual  : "+JSON.stringify(actual));}
}
function truthy(label,actual){
  const ok=!!actual;
  if(ok){pass++;console.log("  PASS  "+label);}
  else{fail++;console.log("  FAIL  "+label+"  (got falsy: "+JSON.stringify(actual)+")");}
}
function group(name,fn){console.log("\n"+name);fn();}

const COMPANY={code:"ACME",name:"Acme Builders Pte Ltd"};
const PROJECT={code:"PROJA",name:"Project Alpha"};
const FIXED_DATE=new Date(Date.UTC(2026,3,24,2,30,0)); // 2026-04-24

// ───────────────────────────────────────────────────────────────────────
group("1. Generic defect photo (no element / no checkpoint)",function(){
  const defect={
    id:"a1b2c3d4ef",
    block:"B1",
    locationLevel:"L02",
    trade:"Architectural",
    status:"Open",
    createdAt:FIXED_DATE
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    type:"DEF",
    seq:1,
    hashShort:"a1b2c3d4",
    ext:"jpg"
  });
  eq("filename shape",fn,
    "PROJA-ACME-B1-L02-DEF-A-A1B2C3D4-S2-20260424_01_a1b2c3d4.jpg");
  const p=parseIso19650Filename(fn);
  truthy("parses",p);
  eq("project",p.project,"PROJA");
  eq("originator",p.originator,"ACME");
  eq("type",p.type,"DEF");
  eq("role",p.role,"A");
  eq("suitability",p.suitability,"S2");
  eq("date",p.date,"20260424");
  eq("seq",p.seq,1);
  eq("element (none)",p.element,"");
  eq("checkpoint (none)",p.checkpoint,"");
  eq("hash",p.hashShort,"a1b2c3d4");
  eq("ext",p.ext,"jpg");
  eq("containerId",p.containerId,"PROJA-ACME-B1-L02-DEF-A-A1B2C3D4");
});

// ───────────────────────────────────────────────────────────────────────
group("2. CONQUAS checkpoint photo (element + hyphenated checkpoint id)",function(){
  const defect={
    id:"f00dface11",
    block:"B1",
    locationLevel:"L02",
    trade:"Architectural",
    status:"In Progress",
    createdAt:FIXED_DATE
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    type:"CQI",
    seq:3,
    element:"WL",
    checkpoint:"1X-WL-02",
    hashShort:"deadbeef",
    ext:"jpg"
  });
  eq("filename shape",fn,
    "PROJA-ACME-B1-L02-CQI-A-F00DFACE-S3-20260424_03_WL_1X-WL-02_deadbeef.jpg");
  const p=parseIso19650Filename(fn);
  truthy("parses",p);
  eq("type",p.type,"CQI");
  eq("suitability",p.suitability,"S3");
  eq("seq",p.seq,3);
  eq("element",p.element,"WL");
  eq("checkpoint preserved with hyphens",p.checkpoint,"1X-WL-02");
  eq("hash",p.hashShort,"deadbeef");
});

// ───────────────────────────────────────────────────────────────────────
group("3. Whole-project (ZZ-ZZ) — functional test photo, M&E trade",function(){
  const defect={
    id:"abcdef12",
    block:"",            // → ZZ
    locationLevel:"",    // → ZZ
    trade:"Mechanical",
    status:"Done",
    createdAt:FIXED_DATE
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    type:"CQF",
    seq:1,
    element:"ME",
    hashShort:"cafebabe",
    ext:"jpg"
  });
  eq("filename shape",fn,
    "PROJA-ACME-ZZ-ZZ-CQF-M-ABCDEF12-S4-20260424_01_ME_cafebabe.jpg");
  const p=parseIso19650Filename(fn);
  eq("volume = ZZ",p.volume,"ZZ");
  eq("level = ZZ",p.level,"ZZ");
  eq("role = M (Mechanical)",p.role,"M");
  eq("suitability = S4 (Done)",p.suitability,"S4");
  eq("element",p.element,"ME");
  eq("checkpoint (none)",p.checkpoint,"");
});

// ───────────────────────────────────────────────────────────────────────
group("4. Hash-mismatch detection",function(){
  const stored="PROJA-ACME-B1-L02-PH-A-DEADBEEF-S2-20260424_01_a1b2c3d4.jpg";
  const p=parseIso19650Filename(stored);
  truthy("parses original",p);
  // Caller computed full SHA-256 of the file currently on disk; first 8 hex
  // are e.g. "ffffffff" — does not match the parsed hash → mismatch.
  const fileHashFull="ffffffff0123456789abcdef0123456789abcdef0123456789abcdef01234567";
  const matches=fileHashFull.slice(0,8).toLowerCase()===p.hashShort;
  eq("hash mismatch flagged",matches,false);

  // Positive control: same file as recorded should match.
  const goodFull="a1b2c3d40123456789abcdef0123456789abcdef0123456789abcdef01234567";
  const goodMatches=goodFull.slice(0,8).toLowerCase()===p.hashShort;
  eq("matching hash passes",goodMatches,true);
});

// ───────────────────────────────────────────────────────────────────────
group("5. Revision suffix lands before underscore tail",function(){
  const defect={
    id:"a1b2c3d4",block:"B1",locationLevel:"L02",
    trade:"Architectural",status:"Verified",createdAt:FIXED_DATE
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    type:"AFT",revision:2,seq:1,hashShort:"a1b2c3d4",ext:"jpg"
  });
  eq("R02 between date and tail",fn,
    "PROJA-ACME-B1-L02-AFT-A-A1B2C3D4-A1-20260424-R02_01_a1b2c3d4.jpg");
  const p=parseIso19650Filename(fn);
  eq("revision parsed",p.revision,2);
  eq("date still parsed",p.date,"20260424");
  eq("seq still parsed",p.seq,1);
});

// ───────────────────────────────────────────────────────────────────────
group("7. Issue segment — defect-type slug embedded in tail",function(){
  // Issue from defect record (auto-pulled, no opts override).
  const defect={
    id:"a1b2c3d4",block:"B1",locationLevel:"L02",
    trade:"Architectural",status:"Open",createdAt:FIXED_DATE,
    issue:"Hollowness"
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    seq:1,element:"WL",hashShort:"a1b2c3d4",ext:"jpg"
  });
  eq("element + issue + hash",fn,
    "PROJA-ACME-B1-L02-PH-A-A1B2C3D4-S2-20260424_01_WL_HOLLOWNESS_a1b2c3d4.jpg");
  const p=parseIso19650Filename(fn);
  truthy("parses",p);
  eq("element parsed",p.element,"WL");
  eq("issue parsed",p.issue,"HOLLOWNESS");
  eq("checkpoint (none)",p.checkpoint,"");
  eq("hash",p.hashShort,"a1b2c3d4");
});

// ───────────────────────────────────────────────────────────────────────
group("8. Issue + CONQUAS checkpoint coexist in tail",function(){
  const defect={
    id:"f00dface",block:"B1",locationLevel:"L02",
    trade:"Architectural",status:"In Progress",createdAt:FIXED_DATE,
    issue:"Lippage"
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    seq:2,element:"FL",checkpoint:"1X-FL-03",hashShort:"deadbeef",ext:"jpg"
  });
  eq("element + issue + checkpoint",fn,
    "PROJA-ACME-B1-L02-PH-A-F00DFACE-S3-20260424_02_FL_LIPPAGE_1X-FL-03_deadbeef.jpg");
  const p=parseIso19650Filename(fn);
  eq("element parsed",p.element,"FL");
  eq("issue parsed",p.issue,"LIPPAGE");
  eq("checkpoint preserved with hyphens",p.checkpoint,"1X-FL-03");
});

// ───────────────────────────────────────────────────────────────────────
group("9. Short / noisy issue is dropped, not embedded",function(){
  // 3-char input would collide with element slot — must be omitted, not
  // embedded as a misleading element code.
  const defect={
    id:"abcd1234",block:"B1",locationLevel:"L02",
    trade:"Architectural",status:"Open",createdAt:FIXED_DATE,
    issue:"NA"   // too short → no segment
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    seq:1,element:"WL",hashShort:"a1b2c3d4",ext:"jpg"
  });
  eq("no spurious issue segment",fn,
    "PROJA-ACME-B1-L02-PH-A-ABCD1234-S2-20260424_01_WL_a1b2c3d4.jpg");
  const p=parseIso19650Filename(fn);
  eq("issue empty",p.issue,"");
});

// ───────────────────────────────────────────────────────────────────────
group("10. Issue opts override beats defect.issue",function(){
  const defect={
    id:"abcd1234",block:"B1",locationLevel:"L02",
    trade:"Architectural",status:"Open",createdAt:FIXED_DATE,
    issue:"Hollowness"   // would normally win
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    seq:1,element:"WL",issue:"Crack",hashShort:"a1b2c3d4",ext:"jpg"
  });
  // opts.issue wins over defect.issue
  const p=parseIso19650Filename(fn);
  eq("opts.issue wins",p.issue,"CRACK");
});

// ───────────────────────────────────────────────────────────────────────
group("6. Round-trip — strict-ISO container ID stays identical",function(){
  const defect={
    id:"deadbeef",block:"T03",locationLevel:"L05",
    trade:"Structural",status:"Closed",createdAt:FIXED_DATE
  };
  const fn=isoNameForDefect(defect,COMPANY,PROJECT,{
    type:"PH",seq:7,element:"FL",checkpoint:"3X-FL-01",hashShort:"01234567",ext:"jpg"
  });
  const p=parseIso19650Filename(fn);
  eq("containerId round-trips",p.containerId,
    "PROJA-ACME-T03-L05-PH-S-DEADBEEF");
});

console.log("\n────────────────────────────────");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);

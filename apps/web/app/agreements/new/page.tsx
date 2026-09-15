'use client';

import { useMemo, useState } from 'react';
import './intake.css';

type Path = 'DIRECT_DESCRIPTION' | 'INFORMAL_ARTIFACT' | 'FORMAL_DOCUMENT';
const choices: Array<{type:Path;title:string;copy:string}> = [
  { type:'DIRECT_DESCRIPTION', title:'Create from scratch', copy:'Tell us the deal in plain language. AssuraPay will structure the terms and show what is missing.' },
  { type:'INFORMAL_ARTIFACT', title:'Use what you already have', copy:'Start from a quote, invoice, proposal, email or message trail.' },
  { type:'FORMAL_DOCUMENT', title:'Upload a contract', copy:'Start from an existing formal agreement and turn it into an executable transaction.' },
];

export default function NewAgreementPage() {
  const [path,setPath]=useState<Path>('DIRECT_DESCRIPTION');
  const [source,setSource]=useState('');
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<any>(null);
  const selected=useMemo(()=>choices.find(c=>c.type===path)!,[path]);

  async function structureAgreement(){
    setBusy(true); setResult(null);
    try {
      const response=await fetch('/api/v1/agreement-intakes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceType:path,rawSource:source,sourceArtifactIds:[],proposedTerms:[]})});
      const body=await response.json();
      if(!response.ok) throw new Error(body?.error ?? 'Unable to structure agreement');
      setResult(body);
    } catch(error){ setResult({error:error instanceof Error?error.message:'Unable to structure agreement'}); }
    finally { setBusy(false); }
  }

  return <main><section className="intake-shell">
    <span className="hero__eyebrow">Start an agreement</span><h1>How would you like to begin?</h1>
    <p>Bring as much or as little as you have. Every path converges into one clear Assura Agreement before execution.</p>
    <div className="intake-paths" role="radiogroup" aria-label="Agreement starting point">{choices.map(choice=><button key={choice.type} type="button" role="radio" aria-checked={path===choice.type} className={`intake-path ${path===choice.type?'intake-path--selected':''}`} onClick={()=>setPath(choice.type)}><strong>{choice.title}</strong><span>{choice.copy}</span></button>)}</div>
    <div className="intake-editor"><h2>{selected.title}</h2><label htmlFor="agreement-source">Describe or paste what has been agreed</label><textarea id="agreement-source" value={source} onChange={e=>setSource(e.target.value)} placeholder="Example: ABC Roofing will replace my roof for $18,000 by October 17..." rows={8}/><p className="intake-note">AssuraPay does not silently accept extracted terms. Missing or ambiguous terms are surfaced for review before a canonical agreement is created.</p><button className="button button--primary" disabled={busy||!source.trim()} onClick={structureAgreement}>{busy?'Structuring…':'Structure agreement'}</button></div>
    {result && <section className="intake-review" aria-live="polite">{result.error?<><h2>We could not continue</h2><p>{result.error}</p></>:<><h2>Agreement review</h2><p><strong>Readiness: {result.clarityScore}%</strong></p><p>{result.status==='NEEDS_CLARIFICATION'?'Resolve the missing terms below before review and conversion.':'The intake is ready for review.'}</p>{result.clarifications?.map((item:any)=><div className="intake-gap" key={item.id}><strong>{item.key}</strong><span>{item.question}</span></div>)}</>}</section>}
  </section></main>;
}

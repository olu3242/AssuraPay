import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
export type AgreementIntakeSourceType='DIRECT_DESCRIPTION'|'INFORMAL_ARTIFACT'|'FORMAL_DOCUMENT';
export type IntakeSourceReference={artifactId?:string;section?:string;page?:number;startOffset?:number;endOffset?:number};
export type ProposedAgreementTerm={key:string;value:unknown;confidence:number;sourceReferences:IntakeSourceReference[]};
export type ClarificationItem={id:string;key:string;question:string;required:boolean;status:'OPEN'|'RESOLVED';answer?:unknown};
export type AgreementIntake={id:string;workspaceId:string;sourceType:AgreementIntakeSourceType;sourceArtifactIds:string[];sourceHash:string;proposedTerms:ProposedAgreementTerm[];clarifications:ClarificationItem[];clarityScore:number;status:'INGESTED'|'NEEDS_CLARIFICATION'|'READY_FOR_REVIEW'|'CONVERTED';createdBy:string;createdAt:string;convertedAgreementId?:string};
const REQUIRED=['title','parties','scope','currency','value','paymentTerms'];
const digest=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
function workspace(c:RequestContext){requireActiveWorkspace(c);return c.activeWorkspaceId}
function present(t:ProposedAgreementTerm[]){return new Set(t.filter(x=>x.value!==undefined&&x.value!==null&&x.value!=='').map(x=>x.key))}
function score(t:ProposedAgreementTerm[]){const p=present(t);return Math.round(REQUIRED.filter(k=>p.has(k)).length/REQUIRED.length*100)}
function gaps(t:ProposedAgreementTerm[]):ClarificationItem[]{const p=present(t);return REQUIRED.filter(k=>!p.has(k)).map(key=>({id:randomUUID(),key,question:`Provide the agreement ${key}.`,required:true,status:'OPEN'}))}
export class AgreementIntakeEngine{
 constructor(private persistence:TrustPersistence){}
 async get(context:RequestContext,id:string){const r=(await this.persistence.list<AgreementIntake>('agreementIntakes')).find(x=>x.id===id&&x.workspaceId===workspace(context));if(!r)throw new Error('NOT_FOUND');return r}
 async ingest(context:RequestContext,input:{sourceType:AgreementIntakeSourceType;sourceArtifactIds?:string[];rawSource:string;proposedTerms:ProposedAgreementTerm[]}){
  if(!input.rawSource.trim())throw new Error('AGREEMENT_SOURCE_REQUIRED');
  for(const term of input.proposedTerms){if(!Number.isFinite(term.confidence)||term.confidence<0||term.confidence>1)throw new Error('INVALID_EXTRACTION_CONFIDENCE');if(input.sourceType!=='DIRECT_DESCRIPTION'&&!term.sourceReferences.length)throw new Error('SOURCE_REFERENCE_REQUIRED')}
  const clarifications=gaps(input.proposedTerms),clarityScore=score(input.proposedTerms);const record:AgreementIntake={id:randomUUID(),workspaceId:workspace(context),sourceType:input.sourceType,sourceArtifactIds:input.sourceArtifactIds??[],sourceHash:digest(input.rawSource),proposedTerms:input.proposedTerms,clarifications,clarityScore,status:clarifications.length?'NEEDS_CLARIFICATION':'READY_FOR_REVIEW',createdBy:context.actorUserId,createdAt:new Date().toISOString()};
  await this.persistence.append('agreementIntakes',record);await this.persistence.audit({tenantId:context.tenantId,workspaceId:record.workspaceId,actorId:context.actorUserId,eventType:'AgreementIntakeCreated',aggregateType:'AgreementIntake',aggregateId:record.id,correlationId:context.correlationId,metadata:{sourceType:record.sourceType,clarityScore,sourceHash:record.sourceHash}});return record
 }
 async resolveClarification(context:RequestContext,id:string,clarificationId:string,answer:unknown){const r=await this.get(context,id);if(r.status==='CONVERTED')throw new Error('CONVERTED_INTAKE_IMMUTABLE');const target=r.clarifications.find(x=>x.id===clarificationId);if(!target)throw new Error('CLARIFICATION_NOT_FOUND');if(answer===undefined||answer===null||answer==='')throw new Error('CLARIFICATION_ANSWER_REQUIRED');const clarifications=r.clarifications.map(x=>x.id===clarificationId?{...x,answer,status:'RESOLVED' as const}:x),proposedTerms=[...r.proposedTerms.filter(x=>x.key!==target.key),{key:target.key,value:answer,confidence:1,sourceReferences:[]}];const updated={...r,clarifications,proposedTerms,clarityScore:score(proposedTerms),status:clarifications.some(x=>x.required&&x.status==='OPEN')?'NEEDS_CLARIFICATION' as const:'READY_FOR_REVIEW' as const};await this.persistence.replace('agreementIntakes',updated);return updated}
 async markConverted(context:RequestContext,id:string,agreementId:string){const r=await this.get(context,id);if(r.status==='CONVERTED'&&r.convertedAgreementId===agreementId)return r;if(r.status!=='READY_FOR_REVIEW')throw new Error('INTAKE_NOT_READY');if(!agreementId)throw new Error('AGREEMENT_ID_REQUIRED');const updated={...r,status:'CONVERTED' as const,convertedAgreementId:agreementId};await this.persistence.replace('agreementIntakes',updated);return updated}
}

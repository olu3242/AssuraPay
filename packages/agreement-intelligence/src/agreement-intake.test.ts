import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { AgreementIntakeEngine } from './agreement-intake';
import { AgreementIntakeConvergenceService } from './agreement-intake-convergence';

const context={actorUserId:'buyer',sessionId:'s',identityAssuranceLevel:'IAL2_VERIFIED' as const,activeWorkspaceId:'w1',tenantId:'t1',memberships:['w1'],correlationId:'corr'};
const terms=(withRefs=false)=>['title','parties','scope','currency','value','paymentTerms'].map((key,index)=>({key,value:key==='title'?'Roof replacement':key==='currency'?'USD':key==='value'?18000:`value-${index}`,confidence:.95,sourceReferences:withRefs?[{artifactId:'a1',section:'terms'}]:[]}));

describe('agreement intake convergence',()=>{
  it.each([
    ['DIRECT_DESCRIPTION',false],['INFORMAL_ARTIFACT',true],['FORMAL_DOCUMENT',true],
  ] as const)('%s converges to review without bypassing human confirmation',async(sourceType,withRefs)=>{
    const store=new InMemoryTrustStore(),engine=new AgreementIntakeEngine(store);
    const intake=await engine.ingest(context,{sourceType,rawSource:'source material',sourceArtifactIds:withRefs?['a1']:[],proposedTerms:terms(withRefs)});
    expect(intake.status).toBe('READY_FOR_REVIEW');
    const created:string[]=[];
    const service=new AgreementIntakeConvergenceService(engine,{create:async(_c,input)=>{created.push(input.idempotencyKey);return{id:'agreement-1'}}});
    await expect(service.convert(context,intake.id)).rejects.toThrow('INTAKE_REVIEW_REQUIRED');
    expect((await engine.confirmReview(context,intake.id)).status).toBe('REVIEWED');
    expect(await service.convert(context,intake.id)).toEqual({id:'agreement-1',alreadyConverted:false});
    expect(await service.convert(context,intake.id)).toEqual({id:'agreement-1',alreadyConverted:true});
    expect(created).toEqual([`agreement-intake:${intake.id}`]);
  });

  it('forces ambiguity resolution before review',async()=>{
    const store=new InMemoryTrustStore(),engine=new AgreementIntakeEngine(store);
    const intake=await engine.ingest(context,{sourceType:'DIRECT_DESCRIPTION',rawSource:'Build my website for $5,000',proposedTerms:[{key:'value',value:5000,confidence:1,sourceReferences:[]}]});
    expect(intake.status).toBe('NEEDS_CLARIFICATION');
    await expect(engine.confirmReview(context,intake.id)).rejects.toThrow('INTAKE_NOT_READY_FOR_REVIEW');
    let current=intake;
    for(const gap of intake.clarifications) current=await engine.resolveClarification(context,intake.id,gap.id,`resolved-${gap.key}`);
    expect(current.status).toBe('READY_FOR_REVIEW');
  });

  it('does not expose an intake across workspaces',async()=>{
    const store=new InMemoryTrustStore(),engine=new AgreementIntakeEngine(store);
    const intake=await engine.ingest(context,{sourceType:'DIRECT_DESCRIPTION',rawSource:'complete',proposedTerms:terms()});
    await expect(engine.get({...context,activeWorkspaceId:'w2',memberships:['w2']},intake.id)).rejects.toThrow('NOT_FOUND');
  });
});

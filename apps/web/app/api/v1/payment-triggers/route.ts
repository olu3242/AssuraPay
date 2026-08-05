import {errorResponse,governance,authorizedContextForRoute} from '../../../../lib/trust-app';
export async function POST(request:Request){try{return Response.json(await governance.paymentTriggers.define(await authorizedContextForRoute(request),await request.json()),{status:201});}catch(error){return errorResponse(error)}}

import {errorResponse,governance,requestContext} from '../../../../lib/trust-app';
export async function POST(request:Request){try{return Response.json(governance.paymentTriggers.define(requestContext(request),await request.json()),{status:201});}catch(error){return errorResponse(error)}}

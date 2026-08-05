import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{const body=await request.json();return Response.json(governance.paymentTriggers.propose(authorizedContextForRoute(request),params.id,body.idempotencyKey),{status:201});}catch(error){return errorResponse(error)}}

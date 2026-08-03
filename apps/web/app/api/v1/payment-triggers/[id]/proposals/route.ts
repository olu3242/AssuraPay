import {errorResponse,governance,requestContext} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{const body=await request.json();return Response.json(governance.paymentTriggers.propose(requestContext(request),params.id,body.idempotencyKey),{status:201});}catch(error){return errorResponse(error)}}

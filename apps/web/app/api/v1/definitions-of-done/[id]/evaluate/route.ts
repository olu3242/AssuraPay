import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(governance.dod.evaluate(authorizedContextForRoute(request),params.id,await request.json()),{status:201});}catch(error){return errorResponse(error)}}

import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(governance.dod.publish(authorizedContextForRoute(request),params.id));}catch(error){return errorResponse(error)}}

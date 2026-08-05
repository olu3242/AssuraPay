import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(await governance.dod.publish(await authorizedContextForRoute(request),params.id));}catch(error){return errorResponse(error)}}

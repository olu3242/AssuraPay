import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(await governance.certifications.issue(await authorizedContextForRoute(request),params.id),{status:201});}catch(error){return errorResponse(error)}}

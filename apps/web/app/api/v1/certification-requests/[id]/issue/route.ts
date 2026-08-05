import {errorResponse,governance,authorizedContextForRoute} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(governance.certifications.issue(authorizedContextForRoute(request),params.id),{status:201});}catch(error){return errorResponse(error)}}

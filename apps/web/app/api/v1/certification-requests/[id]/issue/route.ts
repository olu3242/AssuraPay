import {errorResponse,governance,requestContext} from '../../../../../../lib/trust-app';
export async function POST(request:Request,{params}:{params:{id:string}}){try{return Response.json(governance.certifications.issue(requestContext(request),params.id),{status:201});}catch(error){return errorResponse(error)}}

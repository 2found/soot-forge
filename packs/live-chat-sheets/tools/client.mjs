import { GoogleAuth, OAuth2Client } from 'google-auth-library';

export class SheetsError extends Error {
  constructor(code,status=0,uncertain=false){super(code);this.code=code;this.status=status;this.uncertain=uncertain;}
}
export const SHEETS_SCOPE='https://www.googleapis.com/auth/spreadsheets';
export const MAX_RESPONSE_BYTES=1024*1024;

async function boundedResponse(response) {
  const declared=response.headers.get('content-length');
  if(!response.body || declared!==null && (!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE_BYTES)) {await response.body?.cancel();throw new Error('Invalid response');}
  const reader=response.body.getReader();const chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES)throw new Error('Response too large');chunks.push(value);}
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid response');
    return data;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
// Tokens resolve on the adapter host immediately before a request. This client
// never returns Google credentials to a Soot tool result or browser widget.
export class SheetsClient {
  constructor({serviceAccount,oauth,fetch:transport=globalThis.fetch}){
    this.fetch=transport;
    this.auth=serviceAccount?new GoogleAuth({credentials:serviceAccount,scopes:[SHEETS_SCOPE],clientOptions:{transporterOptions:{timeout:12000,retry:false}}}):oauth;
    if(!this.auth)throw new SheetsError('google_not_connected',401);
  }
  async request(path,method='GET',input){
    let token;try{const resolved=await this.auth.getAccessToken();token=typeof resolved==='string'?resolved:resolved?.token;}catch{throw new SheetsError('google_reconnect_required',401);}
    if(!token)throw new SheetsError('google_reconnect_required',401);
    let response;
    try{response=await this.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+path,{method,headers:{Authorization:'Bearer '+token,...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined,redirect:'error',signal:AbortSignal.timeout(12000)});}
    catch{throw new SheetsError('google_transport_unknown',0,method!=='GET');}
    if(!response.ok){await response.body?.cancel();throw new SheetsError(response.status===429?'google_quota':response.status===401?'google_reconnect_required':response.status===403?'google_permission_denied':response.status===404?'google_destination_missing':'google_request_failed',response.status,method!=='GET'&&(response.status>=500||response.status===408));}
    try{return await boundedResponse(response);}catch{throw new SheetsError('google_response_unknown',0,method!=='GET');}
  }
  async validate(spreadsheet,tab){const data=await this.request(encodeURIComponent(spreadsheet)+'?fields=spreadsheetId,sheets.properties');if(data.spreadsheetId!==spreadsheet||!Array.isArray(data.sheets))throw new SheetsError('google_response_unknown');const sheet=data.sheets.find(s=>s.properties?.title===tab);if(!sheet)throw new SheetsError('google_tab_missing',404);return {spreadsheet_id:data.spreadsheetId,tab,rows:sheet.properties.gridProperties?.rowCount??0};}
  async read(spreadsheet,range){const values=(await this.request(encodeURIComponent(spreadsheet)+'/values/'+encodeURIComponent(range))).values??[];if(!Array.isArray(values)||values.length>2000||values.some(row=>!Array.isArray(row)))throw new SheetsError('google_response_unknown');return values;}
  async write(spreadsheet,range,values){
    if(!Array.isArray(values)||!values.length||values.length>2000||values.some(row=>!Array.isArray(row)||!row.length||row.some(value=>!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)))||values.reduce((n,row)=>n+row.length,0)>16000)throw new SheetsError('google_invalid_values',400);
    if(values.some(row=>row.some(value=>String(value).length>50000))||Buffer.byteLength(JSON.stringify(values))>MAX_RESPONSE_BYTES)throw new SheetsError('google_cell_too_large',400);
    return this.request(encodeURIComponent(spreadsheet)+'/values/'+encodeURIComponent(range)+'?valueInputOption=RAW','PUT',{range,majorDimension:'ROWS',values});
  }
}
export function oauthClient(config){return new OAuth2Client({clientId:config.clientId,clientSecret:config.clientSecret,redirectUri:config.redirectUri,transporterOptions:{timeout:12000,retry:false}});}

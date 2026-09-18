/** Race an operator callback against a timeout; the signal aborts and the race rejects when the deadline passes. */
export async function withDeadline<T>(fn:(signal:AbortSignal)=>Promise<T>,ms:number,message:string):Promise<T> {
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([fn(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(message));},ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}

import json,sys
for f in sys.argv[1:]:
    print("=====",f)
    tot={}; t0=None
    seen=set()
    for l in open(f):
        r=json.loads(l); ts=r.get('timestamp')
        m=r.get('message',{})
        if r.get('type')=='assistant':
            mid=m.get('id')
            u=m.get('usage',{})
            if mid not in seen:
                seen.add(mid)
                for k in ('input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'): tot[k]=tot.get(k,0)+u.get(k,0)
            for c in m.get('content',[]):
                if c.get('type')=='tool_use':
                    i=c['input']; print(ts,'TOOL',c['name'],json.dumps(i)[:230])
        elif r.get('type')=='user':
            c=m.get('content')
            if isinstance(c,list):
                for x in c:
                    if x.get('type')=='tool_result':
                        b=x.get('content'); b=b if isinstance(b,str) else json.dumps(b)
                        print(ts,'  RES',('ERR ' if x.get('is_error') else '')+b[:160].replace('\n','|'))
    print(tot,'assistant msgs',len(seen))

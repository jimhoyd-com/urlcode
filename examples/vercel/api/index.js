// Every request is rewritten here by vercel.json. The handler is created once
// per instance and reused across warm invocations.
import { createVercelHandler } from '@jimhoyd/urlcode/vercel';

export default createVercelHandler({ project: process.cwd() });

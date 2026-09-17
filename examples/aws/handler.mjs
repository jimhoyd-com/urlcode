// Lambda entry point. The runtime activates once per execution environment and
// is reused across warm invocations.
import { createLambdaHandler } from 'urlcode/aws';

export const handler = createLambdaHandler({ project: process.env.LAMBDA_TASK_ROOT ?? process.cwd() });

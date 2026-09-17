# URLCode on AWS Lambda

A native-handler project served by a Lambda Function URL. See
[the adapter guide](../../docs/AWS.md) for what is and is not supported.

```sh
urlcode test --project .     # the same assertions run locally
sam deploy --guided
```

`handler.mjs` serves the project with `createLambdaHandler`. The deployment
package must contain the project files the routes read: the entry YAML, any
includes, and every page, download and static directory.

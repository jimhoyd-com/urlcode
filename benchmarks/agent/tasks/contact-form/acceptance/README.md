# Acceptance: contact form

`requests.json` is run unchanged against both arms. The page body is not
compared, only its status and content type; submission responses are
compared exactly. Nothing is delivered anywhere: the endpoint is judged on
validation and acknowledgement only.

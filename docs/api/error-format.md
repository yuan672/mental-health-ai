# API Error Contract

All API errors use the same client-visible shape:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "用户可理解的错误信息"
  }
}
```

Client responses must not expose stack traces, SQL errors, API keys, server file paths or internal credentials.

Initial error codes:

- `VALIDATION_ERROR`
- `UNAUTHENTICATED`
- `INVALID_CREDENTIALS`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `QUOTA_EXCEEDED`
- `AI_CHAT_DISABLED`
- `AI_INCOGNITO_CONTEXT_LOST`
- `AI_TURN_IN_PROGRESS`
- `AI_PROVIDER_TIMEOUT`
- `AI_PROVIDER_UNAVAILABLE`
- `AGE_VERIFICATION_FAILED`
- `AGE_VERIFICATION_UNAVAILABLE`
- `CONSENT_REQUIRED`
- `CONSENT_OPERATION_CONFLICT`
- `CONSENT_STATE_CHANGED`
- `CONSENT_POLICY_CHANGED`
- `CONSENT_RESULT_UNKNOWN`
- `CONSENT_UNAVAILABLE`
- `DATABASE_ERROR`
- `INTERNAL_ERROR`

`RATE_LIMITED` is a transient HTTP/capacity admission result. A local token-bucket
rejection includes a bounded `Retry-After` header; concurrency saturation may omit
it because no exact completion time is known. `QUOTA_EXCEEDED` is the separate
daily AI product policy and must not be treated as a short retry signal. See
[`http-abuse-protection.md`](http-abuse-protection.md).

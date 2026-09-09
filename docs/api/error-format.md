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
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `QUOTA_EXCEEDED`
- `AI_PROVIDER_UNAVAILABLE`
- `DATABASE_ERROR`
- `INTERNAL_ERROR`

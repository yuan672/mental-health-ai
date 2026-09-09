# AI Architecture

AI provider implementation is intentionally deferred to Phase 3.

The business layer must depend on an application-owned `LLMProvider` interface, not provider-specific SDKs. Risk Detection remains an independent module and may not be replaced by a single system prompt.

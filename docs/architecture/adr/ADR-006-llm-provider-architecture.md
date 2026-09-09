# ADR-006: LLM Provider Architecture

- Status: Accepted (interfaces first; provider implementation belongs to Phase 3)
- Date: 2026-09-09

## Context

The handoff explicitly forbids business code from depending on one LLM provider and requires risk detection to remain an independent safety module.

## Decision

Define an application-owned `LLMProvider` port and provider adapters. Business orchestration depends only on the port.

Required capability shape:

- `chat()`
- `streamChat()`
- `classifyRisk()`
- `embed()`
- `healthCheck()`

Initial future adapters may include `SiliconFlowProvider`, `OpenAICompatibleProvider` and `LocalModelProvider`.

Provider SDK/HTTP payloads must not escape the adapter layer. Risk detection remains a separate module even if an LLM provider is one signal used by it.

## Why this fits

- Supports mainland-available providers without hard-coding the whole product to one vendor.
- Allows provider fallback, model changes and private deployment later.
- Makes provider failures testable with fakes.
- Preserves a distinct AI safety boundary.

## Alternatives

### Direct SiliconFlow calls from conversation services

Fastest first demo.

**Not selected:** it directly violates the handoff and creates provider lock-in.

### General-purpose multi-provider framework from day one

Can offer many adapters.

**Not selected now:** it adds behavior and abstractions not yet required. A small application-owned port is easier to reason about and audit.

## Future impact

Provider routing/fallback can later sit behind the same port. The port must not absorb crisis-flow, quota or user-data-retention logic.

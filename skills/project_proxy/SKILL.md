---
name: project-proxy
description: Use when working on this project's Cursor relay architecture, hybrid local-proxy behavior, grpc or connect transport interception, RunSSE and Bidi forwarding, upstream OpenAI or Anthropic compatible bridging, Cursor settings or argv patching, certificate flow, or diagnostics for why Cursor agent traffic does or does not pass through the local relay.
---

# Project Proxy

Use this skill for this repo's relay design and runtime flow.

## Workflow

1. Start with `references/architecture.md`.
2. Map the requested problem to one of these layers:
   - Cursor config patching
   - local runner lifecycle
   - gRPC/connect decoding
   - upstream provider adaptation
   - UI or workbench bridge
3. Change the smallest layer that can solve the problem.
4. Re-check diagnostics after every transport change.

## Core Principle

This project keeps Cursor local-first at the interception layer, while allowing native Cursor mutation execution when needed:

- Cursor traffic should go to the local relay first.
- The relay classifies the request after interception.
- Non-edit requests can be translated into standard upstream API calls and answered through our Relay path.
- File mutation requests should normally be handed back to Cursor native edit execution so the official `Undo / Keep / Review` flow remains available.

## Read Next

- `references/architecture.md` for the real request path.
- `../cursor_relay_reverse/references/review-bridge.md` when the issue is UI review state instead of transport.

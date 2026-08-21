# Voice

**This README is AI-generated.**

This folder contains the voice transport and its session-scoped Durable Object.

## Purpose

`voice/` owns:

- the authenticated `/api/voice/session` WebSocket route
- one `TillerVoice` Durable Object per terminal session
- streaming speech-to-text and text-to-speech through `@cloudflare/voice`
- voice commands that relay prompts, permission decisions, and output summaries
  through the Hub

The current implementation uses the agent WebSocket transport directly; it
does not have a separate SFU route or SFU Durable Object.

## Design note

The voice stack is separate from planner and implementation-review runs and the
retained, unrouted `ReviewerChatAgent`.

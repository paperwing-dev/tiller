# Tiller

Tiller is our personalized vibe coding platform built with Cloudflare primitives. Think of it as a terminal session manager for remote coding agents. Use your Claude Code/ Codex subscriptions, run on your own server or Cloudflare Containers, and customize however you like.

## Getting Started

1. Have a Paid $5 Cloudflare Account and Github Account.
2. Deploy the hub using the "Cloudflare Deploy" button, and finish the github setup wizard.

[![Deploy Tiller](public/deploy-tiller.svg)](https://install.paperwing.dev/deploy)

## Current Status

This package is currently in Alpha. We are using it to dogfood Tiller, but we are still adding performance updates, underlying features are changing, and designs are updating. Assume settings and plans might not carry over to beta.

It's working pretty well though. Give it a whirl.

## Tiller CLI

The Tiller CLI can be used to authenticate Codex and Claude subscriptions, and allows for connecting directly to remote terminal sessions.

1. `npm install -g @paperwing-dev/tiller`
2. Run `tiller` to connect to the Hub.
3. Run `tiller auth connect` to connect Codex and Claude subscriptions, or name
   one provider to connect only that subscription.

## Q and A

### Can Multiple Users Connect to the Hub?

Tiller is meant for only a single user. The subscription terms for OpenAI and Anthropic are explicit about this, and we haven't handled any of the security concerns associated with multiple users.

### Tiller vs Cloudflare OS

Tiller is focused on managing remote terminals, while Cloudflare OS owns the agent loop itself. Tiller's main benefits are organizing all your remote terminal sessions, making it easier to pass context between all of them, and an opinionated workflow.

If you don't use subscriptions or care about running terminal based coding agents, Cloudflare OS is a better place to start. If you need that functionality, Tiller is a Cloudflare version of a tool like [Agent Deck](https://github.com/asheshgoplani/agent-deck) with our UX choices.

### Why Am I Directed To install.paperwing.dev?

You only interact with paperwing.dev during the install and update. Onboarding would have been a large UX pain otherwise, and a pre-registered callback URL is required for Cloudflare OAuth. There is no tracking in the app. It's all on your personal Cloudflare account beside this check, and updates.

## Contributing/ License

Tiller is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). You can use Tiller personally, inside a company, modify it, fork it, redistribute it, but must make your updates open source under AGPL. This also goes for if you operate a modified version over a network.

For now, contributions are not being accepted. This is again, a tool personal to us, and we are still figuring out how we want to handle open source. Will have a better plan by beta.

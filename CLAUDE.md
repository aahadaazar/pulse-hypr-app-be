@AGENTS.md

## Claude Code adapter

- Use `/verify` to run the repository verification wrapper.
- Use `/review` for a read-only, evidence-based final diff review.
- `.claude/settings.example.json` is an opt-in hook example, not an automatically
  enabled project policy. Review it before copying it to `settings.local.json`.
- `.mcp.json.example` is documentation only. Never enable an MCP server until
  its endpoint, command, permissions, and credential source have been reviewed.

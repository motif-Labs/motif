# ee/ — organisation features

This directory is empty on purpose, and this file explains the line so nobody
has to guess where it will fall later.

**Everything outside this directory is Apache-2.0 and stays that way.** Session
collection, native handoff between tools, search, recall, the MCP server,
ask-a-session, session memory, the dashboard, and every reader are free for any
number of people, forever. Nothing that is free today will be moved in here.

What will eventually live in `ee/` is the set of things a single team never
wants and a large organisation cannot go without:

- SSO **enforcement** and SCIM provisioning (plain SSO login stays free)
- audit log of who read which session
- retention and data-residency policy
- project-level role-based access control
- knowledge reporting across many teams

If you are a company that needs one of these, open an issue — the fastest way
to get something built is to be the reason it exists.

# Mode: tracker — Application Tracker

Reads and displays `data/applications.md`.

**Tracker format:**
```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```

Canonical states (see `templates/states.yml`): `Evaluated` → `Applied` → `Responded` → `Interview` → `Offer` / `Rejected` / `Discarded` / `SKIP`

- `Applied` = the candidate submitted their application
- `Responded` = a recruiter/company reached out and the candidate replied (inbound)
- Outbound LinkedIn outreach (the candidate proactively contacting someone at the company) isn't a separate status — log it in the Notes column of the existing row instead.

If the user asks to update a status, edit the corresponding row.

Also show statistics:
- Total applications
- By status
- Average score
- % with PDF generated
- % with report generated

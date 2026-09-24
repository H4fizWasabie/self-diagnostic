# self-diagnostic (Theoses extension)

After each task settles, scans the session transcript for signs theoses got stuck
or broke a standing rule, and files a GitHub issue so the pattern gets reviewed:
repeated bash failures, error-retry streaks, edit-gate breaches, procura-via-bash.

Single-file extension (`self-diagnostic.ts`), deployed live at
`~/.theoses/agent/extensions/self-diagnostic.ts` on the Theoses VPS.
CI: `tsc --noEmit` against theoses2 typings on every push/PR touching `*.ts`.

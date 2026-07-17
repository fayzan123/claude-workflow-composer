// src/detection/analysis-prompt.ts
import type { RepoDigest } from './digest-builder.js'

/**
 * Build the deep-analysis prompt. The model reads ref-tagged digest lines (one per
 * task the user ran with Claude) and returns recurring, automatable work. It returns
 * the refs that ground each automation; the SERVER computes counts/evidence and the
 * stable id from those refs — never trust the model's arithmetic.
 */
export function buildAnalysisPrompt(digests: RepoDigest[]): string {
  const body = digests.map(d =>
    `## Repo: ${d.repo}\n${d.lines.map(l => l.text).join('\n')}`
  ).join('\n\n')

  return `You are analyzing a developer's Claude Code history to find recurring work worth automating.

Below are task digests, grouped by repository alias. Each line is one task the developer ran:
[ref] date time · "their prompt" · tools used · salient command labels

${body}

Find distinct recurring tasks or standing instructions that appear REPEATEDLY (3 or more times)
and would be worth capturing. Lines whose tools are \`(none)\` can still be useful repeated
instructions; include them when the prompt itself clearly recurs. The server will choose the
smallest artifact, so do not force an instruction to look like a multi-step workflow. Merge
duplicates — the same real task may appear under slightly different prompts; treat those as ONE
automation. Ignore one-off, exploratory, conversational, or acknowledgement-only work.

Respond with ONLY a JSON object — no prose, no markdown fences:
{
  "automations": [
    {
      "title": string,            // short, e.g. "Triage flaky tests and commit the fix"
      "description": string,      // one sentence: what it does and why it recurs
      "steps": string[],          // the procedure, 1-6 concrete steps; one grounded instruction is valid
      "stepTokens": string[],     // lowercase canonical tokens for the steps, e.g. ["run-tests","commit","push"]
      "refs": string[],           // EVERY digest ref that belongs to this automation, e.g. ["r0","r4","r9"]
      "suggestedTrigger": {
        "kind": "schedule" | "event" | "manual",
        "cron": string,           // a cron expression if kind is "schedule", else ""
        "label": string           // human text, e.g. "weekday mornings ~9am"
      },
      "confidence": number        // 0..1 — how clearly this is a real, automatable recurring task
    }
  ]
}

Rank automations by confidence, highest first. Return an empty array if nothing recurs 3+ times.`
}

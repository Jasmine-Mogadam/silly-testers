import * as fs from 'fs';
import * as path from 'path';
import type { Finding, ReportType, Severity, Team } from './types';

const TEAM_DIR: Record<string, string> = {
  qa: 'qa',
  red: 'red-team',
  devops: 'devops',
};

export class Reporter {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of Object.values(TEAM_DIR)) {
      fs.mkdirSync(path.join(this.outputDir, dir), { recursive: true });
    }
  }

  /**
   * Write a finding to a Markdown file designed to be pasted into a coding LLM.
   * Returns the path of the written file.
   */
  write(finding: Finding): string {
    const md = this.buildMarkdown(finding);
    const slug = slugify(finding.title);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const teamDir = TEAM_DIR[finding.team] ?? finding.team;
    const filename = `${timestamp}_${slug}.md`;
    const filePath = path.join(this.outputDir, teamDir, filename);

    fs.writeFileSync(filePath, md, 'utf8');
    return filePath;
  }

  /**
   * Write a plain text/markdown summary (e.g., DevOps recovery report).
   */
  writeRaw(team: Team, name: string, content: string): string {
    const teamDir = TEAM_DIR[team] ?? String(team);
    const filePath = path.join(this.outputDir, teamDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  private buildMarkdown(f: Finding): string {
    const lines: string[] = [];

    lines.push(`# [${f.type}] ${f.title}`);
    lines.push('');
    lines.push(`**Team:** ${capitalize(String(f.team))}`);
    lines.push(`**Severity:** ${f.severity}`);
    lines.push(`**URL:** ${f.url}`);
    lines.push(`**Timestamp:** ${new Date().toISOString()}`);
    lines.push('');

    lines.push('## Summary');
    lines.push(f.summary);
    lines.push('');

    if (f.steps.length > 0) {
      lines.push('## Steps to Reproduce');
      f.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      lines.push('');
    }

    if (f.evidence) {
      lines.push('## Evidence');
      lines.push(`> ${f.evidence.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }

    if (f.codeRefs.length > 0) {
      lines.push('## Code References');
      for (const ref of f.codeRefs) {
        const location = ref.line ? `${ref.file}:${ref.line}` : ref.file;
        lines.push(`\`${location}\``);
        if (ref.snippet) {
          lines.push('```');
          lines.push(ref.snippet);
          lines.push('```');
        }
        lines.push('');
      }
    }

    if (f.suggestedFix) {
      lines.push('## Suggested Fix');
      lines.push(f.suggestedFix);
      lines.push('');
    }

    return lines.join('\n');
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
